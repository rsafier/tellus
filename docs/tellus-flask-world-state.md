# Tellus World State Routes for Flask/Mongo

Tellus can use the 3D asset-store Flask API as durable world storage while the
Cloudflare Durable Object remains the live WebSocket coordinator.

The world schema mirrors the asset-store model schema:

```json
{
  "worldId": "main",
  "name": "Tellus",
  "description": "Shared public terrarium",
  "is_public": true,
  "owner": {
    "id": "6650f1a2b3c4d5e6f7a8b9c0",
    "username": "jane"
  }
}
```

Add routes like these to the Flask app that already owns MongoDB:

```python
from datetime import datetime, timezone
from flask import Blueprint, current_app, jsonify, request

tellus_world = Blueprint("tellus_world", __name__)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def current_user_summary():
    # Adapt this to the auth object already used by the asset store.
    user = getattr(request, "user", None)
    if not user:
        return {"id": None, "username": "anonymous"}
    return {"id": str(user.id), "username": user.username}


def require_user():
    user = current_user_summary()
    if user["id"] is None:
        return None
    return user


@tellus_world.get("/api/tellus/worlds")
def list_tellus_worlds():
    page = max(int(request.args.get("page", 1)), 1)
    per_page = min(max(int(request.args.get("per_page", 20)), 1), 100)
    search = (request.args.get("search") or "").strip()
    user_only = request.args.get("user_only") in ("1", "true", "True")

    query = {}
    if user_only:
        user = current_user_summary()
        if user["id"] is None:
            return jsonify({"error": "Authentication required"}), 401
        query["owner.id"] = user["id"]
    else:
        query["is_public"] = True
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"description": {"$regex": search, "$options": "i"}},
        ]

    cursor = (
        current_app.mongo.db.tellus_world_states
        .find(query, {"terrain": False, "generated": False, "queuedGenerationJobs": False})
        .sort("savedAt", -1)
    )
    total = current_app.mongo.db.tellus_world_states.count_documents(query)
    worlds = list(cursor.skip((page - 1) * per_page).limit(per_page))
    for world in worlds:
        world.pop("_id", None)
    pages = max((total + per_page - 1) // per_page, 1)
    return jsonify({
        "worlds": worlds,
        "pagination": {
            "page": page,
            "pages": pages,
            "per_page": per_page,
            "total": total,
            "has_prev": page > 1,
            "has_next": page < pages,
        },
    })


@tellus_world.get("/api/tellus/worlds/<world_id>/state")
def get_tellus_world_state(world_id):
    user = current_user_summary()
    doc = current_app.mongo.db.tellus_world_states.find_one(
        {
            "worldId": world_id,
            "$or": [{"is_public": True}, {"owner.id": user["id"]}],
        },
        {"_id": False},
    )
    if not doc:
        return jsonify({"error": "World not found"}), 404
    return jsonify(doc)


@tellus_world.put("/api/tellus/worlds/<world_id>/state")
def put_tellus_world_state(world_id):
    payload = request.get_json(silent=True) or {}
    user = require_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    if payload.get("worldId") not in (None, world_id):
        return jsonify({"error": "worldId mismatch"}), 400
    if not isinstance(payload.get("terrain"), dict):
        return jsonify({"error": "terrain is required"}), 400
    existing = current_app.mongo.db.tellus_world_states.find_one(
        {"worldId": world_id},
        {"owner": True},
    )
    if existing and existing.get("owner", {}).get("id") not in (None, user["id"]):
        return jsonify({"error": "Forbidden"}), 403

    name = payload.get("name") or (existing or {}).get("name") or world_id
    description = payload.get("description") or (existing or {}).get("description") or ""
    is_public = bool(payload.get("is_public", (existing or {}).get("is_public", False)))
    owner = (existing or {}).get("owner") or user

    doc = {
        "version": int(payload.get("version", 1)),
        "worldId": world_id,
        "name": name,
        "description": description,
        "is_public": is_public,
        "owner": owner,
        "terrain": payload["terrain"],
        "generated": payload.get("generated") or [],
        "queuedGenerationJobs": payload.get("queuedGenerationJobs") or [],
        "savedAt": utc_now(),
    }
    current_app.mongo.db.tellus_world_states.update_one(
        {"worldId": world_id},
        {"$set": doc},
        upsert=True,
    )
    return jsonify(doc)


@tellus_world.patch("/api/tellus/worlds/<world_id>")
def patch_tellus_world_metadata(world_id):
    payload = request.get_json(silent=True) or {}
    user = require_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    existing = current_app.mongo.db.tellus_world_states.find_one({"worldId": world_id})
    if not existing:
        return jsonify({"error": "World not found"}), 404
    if existing.get("owner", {}).get("id") not in (None, user["id"]):
        return jsonify({"error": "Forbidden"}), 403

    patch = {}
    for key in ("name", "description"):
        if isinstance(payload.get(key), str):
            patch[key] = payload[key].strip()
    if isinstance(payload.get("is_public"), bool):
        patch["is_public"] = payload["is_public"]
    if not patch:
        return jsonify({"error": "No metadata fields supplied"}), 400
    patch["savedAt"] = utc_now()
    current_app.mongo.db.tellus_world_states.update_one(
        {"worldId": world_id},
        {"$set": patch},
    )
    doc = current_app.mongo.db.tellus_world_states.find_one(
        {"worldId": world_id},
        {"_id": False, "terrain": False, "generated": False, "queuedGenerationJobs": False},
    )
    return jsonify(doc)
```

Register the blueprint wherever the asset-store app registers its other API
routes:

```python
app.register_blueprint(tellus_world)
```

If you protect the route with a bearer token, configure the Worker secret:

```bash
wrangler secret put TELLUS_PERSISTENCE_API_TOKEN --config wrangler.toml
```

Then set the Worker variable:

```text
TELLUS_PERSISTENCE_API_BASE=https://3d.flobots.xyz
```

The Worker sends:

```text
Authorization: Bearer <TELLUS_PERSISTENCE_API_TOKEN>
Content-Type: application/json
```

when the token is configured.

For the browser world picker later, mirror the asset-store model list pattern:

```text
GET /api/tellus/worlds?per_page=24&search=forest
GET /api/tellus/worlds?user_only=true
PATCH /api/tellus/worlds/:worldId
```
