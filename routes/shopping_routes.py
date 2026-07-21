"""Shopping & Recipes module API.

Per-user shopping list and recipe collection with v1 sharing:
- a recipe with is_shared=True is visible (read-only) to every account;
- a user who sets the pref `shopping_list_shared` exposes their list to
  everyone (others can view, check off and add — a household fridge note).
Per-account grants arrive with the accounts feature; the models carry the
owner so nothing needs migrating then.
"""
import json
import logging
import re
import uuid
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.database import SessionLocal, Recipe, ShoppingItem
from src.auth_helpers import get_current_user
from routes.prefs_routes import _load as _load_all_prefs, _load_for_user, _save_for_user

logger = logging.getLogger(__name__)


def _uid() -> str:
    return uuid.uuid4().hex[:12]


class RecipeBody(BaseModel):
    title: str = ""
    instructions: Optional[str] = None
    # Strings ("200ml Milch") or {text, done} dicts — done = checked off
    # while cooking. Normalized to dicts in storage.
    ingredients: Optional[List] = None
    image_url: Optional[str] = None
    is_shared: Optional[bool] = None


def _normalize_ingredients(raw) -> list[dict]:
    out = []
    for i in raw or []:
        if isinstance(i, dict):
            t = str(i.get("text") or "").strip()
            if t:
                out.append({"text": t, "done": bool(i.get("done"))})
        else:
            t = str(i or "").strip()
            if t:
                out.append({"text": t, "done": False})
    return out


class ItemBody(BaseModel):
    text: str = ""


class ItemPatch(BaseModel):
    text: Optional[str] = None
    done: Optional[bool] = None


# Quantity prefix ("200ml", "2", "1 Pck.") for duplicate merging.
_QTY_RE = re.compile(
    r"^([\d.,/½¼¾]+\s*(?:g|kg|mg|ml|cl|dl|l|el|tl|prisen?|stk|stück|pck|packung(?:en)?|bund|dosen?|x|×)?\.?)\s+(.+)$",
    re.IGNORECASE,
)


def _ingredient_parts(text: str) -> tuple[str, str]:
    t = (text or "").strip()
    m = _QTY_RE.match(t)
    return (m.group(1).strip(), m.group(2).strip()) if m else ("", t)


def _ingredient_key(text: str) -> str:
    return re.sub(r"^\d+×\s*", "", _ingredient_parts(text)[1]).lower()


def _merge_titles(existing: str, new: str) -> str:
    """'Milch' + 'Milch' -> '2× Milch'; '200ml Milch' + '1l Milch' ->
    'Milch — 200ml + 1l'; already-joined titles append further quantities."""
    ex_q, ex_n = _ingredient_parts(existing)
    nw_q, _ = _ingredient_parts(new)
    dash = re.match(r"^(.+?) — (.+)$", existing)
    if dash:
        return f"{dash.group(1)} — {dash.group(2)} + {nw_q or new}"
    if not ex_q and not nw_q:
        counted = re.match(r"^(\d+)×\s+(.*)$", existing)
        if counted:
            return f"{int(counted.group(1)) + 1}× {counted.group(2)}"
        return f"2× {existing}"
    return f"{ex_n} — {ex_q or '1×'} + {nw_q or '1×'}"


def _pref_sharers(pref_key: str, exclude: Optional[str] = None) -> list[str]:
    """Owners who flipped the given share pref (list or recipes) in Settings."""
    users = _load_all_prefs().get("_users") or {}
    return [
        u for u, p in users.items()
        if isinstance(p, dict) and p.get(pref_key) and u != exclude
    ]


def _shared_shoppers(exclude: Optional[str] = None) -> list[str]:
    return _pref_sharers("shopping_list_shared", exclude)


def _item_dict(it: ShoppingItem, me: Optional[str]) -> dict:
    return {
        "id": it.id,
        "text": it.text or "",
        "done": bool(it.done),
        "recipe_id": it.recipe_id,
        "owner": it.owner,
        "mine": me is None or it.owner == me,
        "created_at": it.created_at.isoformat() if it.created_at else None,
    }


def _recipe_dict(r: Recipe, me: Optional[str]) -> dict:
    try:
        ingredients = json.loads(r.ingredients or "[]")
    except Exception:
        ingredients = []
    return {
        "id": r.id,
        "title": r.title or "",
        "instructions": r.instructions or "",
        "ingredients": _normalize_ingredients(ingredients if isinstance(ingredients, list) else []),
        "image_url": r.image_url,
        "is_shared": bool(r.is_shared),
        "owner": r.owner,
        "mine": me is None or r.owner == me,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _merge_into_list(db, me: Optional[str], texts: list[str], recipe_id: Optional[str] = None) -> tuple[int, int, list]:
    """Add texts to `me`'s open items, merging duplicates.

    Returns (added, merged, touched_items) — the touched ORM objects let
    callers hand the affected rows straight back to the client."""
    open_items = (
        db.query(ShoppingItem)
        .filter(ShoppingItem.owner == me, ShoppingItem.done == False)  # noqa: E712
        .all()
    )
    # Key each open item once — the scan was O(texts × items) with two
    # regex evaluations per comparison.
    by_key = {_ingredient_key(i.text): i for i in open_items}
    added = merged = 0
    touched = []
    for t in texts:
        t = (t or "").strip()
        if not t:
            continue
        key = _ingredient_key(t)
        dup = by_key.get(key)
        if dup:
            dup.text = _merge_titles(dup.text or "", t)
            merged += 1
        else:
            dup = ShoppingItem(id=_uid(), owner=me, text=t, done=False, recipe_id=recipe_id)
            db.add(dup)
            by_key[key] = dup
            added += 1
        touched.append(dup)
    return added, merged, touched


def setup_shopping_routes():
    router = APIRouter(prefix="/api", tags=["shopping"])

    # ---- shopping list -------------------------------------------------
    @router.get("/shopping")
    def list_items(request: Request):
        me = get_current_user(request)
        # One prefs read serves both questions (who shares with me / do I
        # share) — this endpoint is refetched after every item action.
        users = _load_all_prefs().get("_users") or {}
        sharers = [
            u for u, p in users.items()
            if isinstance(p, dict) and p.get("shopping_list_shared") and u != me
        ]
        shared = bool((users.get(me) or {}).get("shopping_list_shared")) if me is not None else False
        db = SessionLocal()
        try:
            q = db.query(ShoppingItem)
            if me is not None:
                q = q.filter(ShoppingItem.owner.in_([me] + sharers))
            items = q.order_by(ShoppingItem.done, ShoppingItem.created_at.desc()).all()
            return {"items": [_item_dict(i, me) for i in items], "list_shared": shared}
        finally:
            db.close()

    @router.post("/shopping")
    def add_item(request: Request, body: ItemBody):
        me = get_current_user(request)
        if not (body.text or "").strip():
            raise HTTPException(400, "text required")
        db = SessionLocal()
        try:
            added, merged, touched = _merge_into_list(db, me, [body.text])
            db.commit()
            # Return the affected row so the client patches its list locally
            # instead of refetching everything per Enter press.
            item = _item_dict(touched[0], me) if touched else None
            return {"added": added, "merged": merged, "item": item}
        finally:
            db.close()

    def _visible_item(db, request, item_id: str) -> ShoppingItem:
        me = get_current_user(request)
        it = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
        if not it:
            raise HTTPException(404, "item not found")
        # Own items always; foreign items only while their owner shares.
        if me is not None and it.owner != me and it.owner not in _shared_shoppers(exclude=me):
            raise HTTPException(403, "not your item")
        return it

    @router.patch("/shopping/{item_id}")
    def patch_item(request: Request, item_id: str, body: ItemPatch):
        db = SessionLocal()
        try:
            it = _visible_item(db, request, item_id)
            if body.text is not None:
                it.text = body.text
            if body.done is not None:
                it.done = bool(body.done)
            db.commit()
            return _item_dict(it, get_current_user(request))
        finally:
            db.close()

    @router.delete("/shopping/{item_id}")
    def delete_item(request: Request, item_id: str):
        db = SessionLocal()
        try:
            it = _visible_item(db, request, item_id)
            db.delete(it)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.post("/shopping/clear-done")
    def clear_done(request: Request):
        me = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(ShoppingItem).filter(ShoppingItem.done == True)  # noqa: E712
            if me is not None:
                q = q.filter(ShoppingItem.owner == me)
            n = q.delete(synchronize_session=False)
            db.commit()
            return {"deleted": n}
        finally:
            db.close()

    @router.put("/shopping/share")
    def set_share(request: Request, body: dict):
        me = get_current_user(request)
        prefs = _load_for_user(me)
        prefs["shopping_list_shared"] = bool(body.get("shared"))
        _save_for_user(me, prefs)
        return {"list_shared": prefs["shopping_list_shared"]}

    # ---- recipes -------------------------------------------------------
    @router.get("/recipes")
    def list_recipes(request: Request):
        me = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(Recipe)
            if me is not None:
                # Sharing is a per-user Settings switch (recipes_shared), not
                # per recipe — mirrors the shopping-list model.
                q = q.filter(Recipe.owner.in_([me] + _pref_sharers("recipes_shared", exclude=me)))
            recipes = q.order_by(Recipe.updated_at.desc()).all()
            return {"recipes": [_recipe_dict(r, me) for r in recipes]}
        finally:
            db.close()

    @router.post("/recipes")
    def create_recipe(request: Request, body: RecipeBody):
        me = get_current_user(request)
        db = SessionLocal()
        try:
            r = Recipe(
                id=_uid(), owner=me, title=body.title or "",
                instructions=body.instructions or "",
                ingredients=json.dumps(_normalize_ingredients(body.ingredients)),
                image_url=body.image_url,
                is_shared=bool(body.is_shared),
            )
            db.add(r)
            db.commit()
            return _recipe_dict(r, me)
        finally:
            db.close()

    def _own_recipe(db, request, recipe_id: str) -> Recipe:
        me = get_current_user(request)
        r = db.query(Recipe).filter(Recipe.id == recipe_id).first()
        if not r:
            raise HTTPException(404, "recipe not found")
        if me is not None and r.owner != me:
            raise HTTPException(403, "not your recipe")
        return r

    def _editable_recipe(db, request, recipe_id: str) -> Recipe:
        """Own recipes plus recipes whose owner shares their collection —
        shared means the whole household may edit them (Alessio 2026-07-21).
        Deleting stays owner-only (see delete_recipe)."""
        me = get_current_user(request)
        r = db.query(Recipe).filter(Recipe.id == recipe_id).first()
        if not r:
            raise HTTPException(404, "recipe not found")
        if me is not None and r.owner != me and r.owner not in _pref_sharers("recipes_shared", exclude=me):
            raise HTTPException(403, "recipe is not shared with you")
        return r

    @router.put("/recipes/{recipe_id}")
    def update_recipe(request: Request, recipe_id: str, body: RecipeBody):
        db = SessionLocal()
        try:
            r = _editable_recipe(db, request, recipe_id)
            r.title = body.title or ""
            if body.instructions is not None:
                r.instructions = body.instructions
            if body.ingredients is not None:
                r.ingredients = json.dumps(_normalize_ingredients(body.ingredients))
            if body.image_url is not None:
                r.image_url = body.image_url
            if body.is_shared is not None:
                r.is_shared = bool(body.is_shared)
            db.commit()
            return _recipe_dict(r, get_current_user(request))
        finally:
            db.close()

    @router.post("/recipes/{recipe_id}/ingredients/{index}/toggle")
    def toggle_ingredient(request: Request, recipe_id: str, index: int):
        """Check an ingredient off while cooking (owner or shared-with)."""
        db = SessionLocal()
        try:
            r = _editable_recipe(db, request, recipe_id)
            try:
                ingredients = _normalize_ingredients(json.loads(r.ingredients or "[]"))
            except Exception:
                ingredients = []
            if not (0 <= index < len(ingredients)):
                raise HTTPException(400, "index out of range")
            ingredients[index]["done"] = not ingredients[index]["done"]
            r.ingredients = json.dumps(ingredients)
            db.commit()
            return {"ingredients": ingredients}
        finally:
            db.close()

    @router.delete("/recipes/{recipe_id}")
    def delete_recipe(request: Request, recipe_id: str):
        db = SessionLocal()
        try:
            r = _own_recipe(db, request, recipe_id)
            db.delete(r)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.post("/recipes/{recipe_id}/to-shopping")
    def recipe_to_shopping(request: Request, recipe_id: str):
        """Every ingredient becomes one item on MY list (shared recipes of
        other users may be cooked too — the items still land on my list)."""
        me = get_current_user(request)
        db = SessionLocal()
        try:
            r = db.query(Recipe).filter(Recipe.id == recipe_id).first()
            if not r:
                raise HTTPException(404, "recipe not found")
            if me is not None and r.owner != me and r.owner not in _pref_sharers("recipes_shared", exclude=me):
                raise HTTPException(403, "recipe is private")
            try:
                ingredients = json.loads(r.ingredients or "[]")
            except Exception:
                ingredients = []
            texts = [i["text"] for i in _normalize_ingredients(ingredients)]
            added, merged, _ = _merge_into_list(db, me, texts, recipe_id=recipe_id)
            db.commit()
            return {"added": added, "merged": merged}
        finally:
            db.close()

    return router
