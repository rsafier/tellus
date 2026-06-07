# Tellus World State Routes for Flask/Postgres

Tellus can use the 3D asset-store Flask API as durable world storage while the
Cloudflare Durable Object remains the live WebSocket coordinator.

The world schema mirrors the asset-store model visibility shape:

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

## SQLAlchemy Model

Use JSONB for the evolving terrain and generated placement payloads.

```python
from sqlalchemy.dialects.postgresql import JSONB


class TellusWorldState(db.Model):
    __tablename__ = "tellus_world_states"

    id = db.Column(db.Integer, primary_key=True)
    world_id = db.Column(db.String(120), unique=True, nullable=False, index=True)
    version = db.Column(db.Integer, nullable=False, default=1)
    name = db.Column(db.String(160), nullable=False)
    description = db.Column(db.Text, nullable=False, default="")
    is_public = db.Column(db.Boolean, nullable=False, default=False, index=True)
    owner = db.Column(JSONB, nullable=False)
    terrain = db.Column(JSONB, nullable=False)
    generated = db.Column(JSONB, nullable=False, default=list)
    queued_generation_jobs = db.Column(JSONB, nullable=False, default=list)
    saved_at = db.Column(db.DateTime(timezone=True), nullable=False, index=True)
```

## Flask Blueprint

Adapt `current_user_summary`, `current_app.db`, and `TellusWorldState` to the
asset-store app's existing auth/database setup.

```python
from datetime import datetime, timezone
from flask import Blueprint, current_app, jsonify, request

tellus_world = Blueprint("tellus_world", __name__)


def current_user_summary():
    user = getattr(request, "user", None)
    if not user:
        return {"id": None, "username": "anonymous"}
    return {"id": str(user.id), "username": user.username}


def require_user():
    user = current_user_summary()
    return None if user["id"] is None else user


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def world_to_summary(world):
    return {
        "worldId": world.world_id,
        "name": world.name,
        "description": world.description,
        "is_public": world.is_public,
        "owner": world.owner,
        "savedAt": iso(world.saved_at),
    }


def world_to_state(world):
    return {
        **world_to_summary(world),
        "version": world.version,
        "terrain": world.terrain,
        "generated": world.generated,
        "queuedGenerationJobs": world.queued_generation_jobs,
    }
```

```python
@tellus_world.get("/api/tellus/worlds")
def list_tellus_worlds():
    page = max(int(request.args.get("page", 1)), 1)
    per_page = min(max(int(request.args.get("per_page", 20)), 1), 100)
    search = (request.args.get("search") or "").strip()
    user_only = request.args.get("user_only") in ("1", "true", "True")
    user = current_user_summary()

    query = TellusWorldState.query
    if user_only:
        if user["id"] is None:
            return jsonify({"error": "Authentication required"}), 401
        query = query.filter(TellusWorldState.owner["id"].astext == user["id"])
    else:
        query = query.filter(TellusWorldState.is_public == True)
    if search:
        like = f"%{search}%"
        query = query.filter(
            (TellusWorldState.name.ilike(like)) |
            (TellusWorldState.description.ilike(like))
        )

    query = query.order_by(TellusWorldState.saved_at.desc())
    total = query.count()
    worlds = query.offset((page - 1) * per_page).limit(per_page).all()
    pages = max((total + per_page - 1) // per_page, 1)
    return jsonify({
        "worlds": [world_to_summary(world) for world in worlds],
        "pagination": {
            "page": page,
            "pages": pages,
            "per_page": per_page,
            "total": total,
            "has_prev": page > 1,
            "has_next": page < pages,
        },
    })
```

```python
@tellus_world.get("/api/tellus/worlds/<world_id>/state")
def get_tellus_world_state(world_id):
    user = current_user_summary()
    world = TellusWorldState.query.filter(
        TellusWorldState.world_id == world_id,
        (
            (TellusWorldState.is_public == True) |
            (TellusWorldState.owner["id"].astext == user["id"])
        ),
    ).first()
    if not world:
        return jsonify({"error": "World not found"}), 404
    return jsonify(world_to_state(world))
```

```python
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

    world = TellusWorldState.query.filter_by(world_id=world_id).first()
    if world and (world.owner or {}).get("id") not in (None, user["id"]):
        return jsonify({"error": "Forbidden"}), 403
    if not world:
        world = TellusWorldState(
            world_id=world_id,
            owner=user,
            name=payload.get("name") or world_id,
            description=payload.get("description") or "",
            is_public=bool(payload.get("is_public", False)),
        )
        current_app.db.session.add(world)

    world.version = int(payload.get("version", 1))
    world.name = payload.get("name") or world.name or world_id
    world.description = payload.get("description") or world.description or ""
    world.is_public = bool(payload.get("is_public", world.is_public or False))
    world.terrain = payload["terrain"]
    world.generated = payload.get("generated") or []
    world.queued_generation_jobs = payload.get("queuedGenerationJobs") or []
    world.saved_at = datetime.now(timezone.utc)

    current_app.db.session.commit()
    return jsonify(world_to_state(world))
```

```python
@tellus_world.patch("/api/tellus/worlds/<world_id>")
def patch_tellus_world_metadata(world_id):
    payload = request.get_json(silent=True) or {}
    user = require_user()
    if user is None:
        return jsonify({"error": "Authentication required"}), 401
    world = TellusWorldState.query.filter_by(world_id=world_id).first()
    if not world:
        return jsonify({"error": "World not found"}), 404
    if (world.owner or {}).get("id") not in (None, user["id"]):
        return jsonify({"error": "Forbidden"}), 403

    changed = False
    for key in ("name", "description"):
        if isinstance(payload.get(key), str):
            setattr(world, key, payload[key].strip())
            changed = True
    if isinstance(payload.get("is_public"), bool):
        world.is_public = payload["is_public"]
        changed = True
    if not changed:
        return jsonify({"error": "No metadata fields supplied"}), 400
    world.saved_at = datetime.now(timezone.utc)
    current_app.db.session.commit()
    return jsonify(world_to_summary(world))
```

Register the blueprint wherever the asset-store app registers API routes:

```python
app.register_blueprint(tellus_world)
```

## Worker Configuration

Tellus will not use Durable Object storage unless explicitly opted in. Use the
Postgres API as the durable store:

```text
TELLUS_PERSISTENCE_API_BASE=https://3d.flobots.xyz
TELLUS_PERSISTENCE_API_TOKEN=...
```

Optional Cloudflare Durable Object storage opt-in:

```text
TELLUS_DO_STORAGE_MODE=durable
```

Leave `TELLUS_DO_STORAGE_MODE` unset to avoid Durable Object storage row-write
limits.
