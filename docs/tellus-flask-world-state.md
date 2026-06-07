# Tellus World State Routes for Flask/Mongo

Tellus can use the 3D asset-store Flask API as durable world storage while the
Cloudflare Durable Object remains the live WebSocket coordinator.

Add routes like these to the Flask app that already owns MongoDB:

```python
from datetime import datetime, timezone
from flask import Blueprint, current_app, jsonify, request

tellus_world = Blueprint("tellus_world", __name__)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@tellus_world.get("/api/tellus/worlds/<world_id>/state")
def get_tellus_world_state(world_id):
    doc = current_app.mongo.db.tellus_world_states.find_one(
        {"worldId": world_id},
        {"_id": False},
    )
    if not doc:
        return jsonify({"error": "World not found"}), 404
    return jsonify(doc)


@tellus_world.put("/api/tellus/worlds/<world_id>/state")
def put_tellus_world_state(world_id):
    payload = request.get_json(silent=True) or {}
    if payload.get("worldId") not in (None, world_id):
        return jsonify({"error": "worldId mismatch"}), 400
    if not isinstance(payload.get("terrain"), dict):
        return jsonify({"error": "terrain is required"}), 400

    doc = {
        "version": int(payload.get("version", 1)),
        "worldId": world_id,
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
