# Devices, services, software and model relationships

Open **Inventory → Devices and services** (`#device-catalog`) for a joined view. The page and
`GET /api/device-catalog` require `security:read`, because software watch rules already have that access boundary.
An empty installation returns empty lists. Missing observations remain unknown.

The catalog uses the existing sources of truth:

- **Device:** the overview's device or an inventory `device` entry. Matching is by exact ID; names are not identity.
- **Service:** an inventory `runtime` entry, optionally linked to an existing runtime endpoint. A live runtime
  reported by a plugin is also visible, with its observed source. Registering a service does not install or start it.
- **Software installation:** an inventory `tool` entry, or one device's detection rule from the software watch.
  A configured detection rule alone does not prove the software is installed: the catalog says `configured` and
  leaves its version unknown. A tool recorded in inventory says `recorded`, with the recorded version.
- **Model deployment:** an observed model placement, with its kind, device, serving service and status. A model
  running on two devices has two deployments. The model/provider remains the source of status.
- **Client uses service:** a recorded inventory dependency of kind `call`, or a link observed in runtime request
  history. A client device that the source does not identify stays `null`. Host/client are roles in these links,
  not mutually exclusive device properties.

There is no additional catalog data file. The read API returns `schemaVersion:1`, `devices`, `services`,
`software`, `models`, `clients`, `uses`, and `warnings`. IDs include their source: `inventory:<entry>`,
`endpoint:<endpoint>`, `runtime:<device>:<runtime>`, `watch:<device>:<watch-item>`, and
`model:<device>:<runtime>:<model>`. Composite components are URI-encoded. Changing display order does not change IDs.
Explicit endpoint links merge registrations with runtime observations. Unlinked records are not guessed together
by similar names. Broken references are listed in `warnings`.

## Register an installed service

The inventory device must exist first. Use `inventory_get` or the inventory page to find its exact ID.
A typed service is still a normal inventory entry of kind `runtime`. Its optional `service` field is:

```json
{
  "kind": "omlx",
  "binary": "/opt/bin/omlx",
  "platform": "macos",
  "mode": "server",
  "port": 8000,
  "endpointId": "server-omlx",
  "watchId": "omlx"
}
```

`endpointId` and `watchId` are optional links to existing records on this device. An endpoint can be linked to
only one service through the registration API. `mode` is `server` with an integer port from 1 to 65535, or
`on-demand` with `port:null` (for example a tool exposed through a job runner). The binary is an absolute path,
including a Windows drive path, or starts with `~/`. Paths are metadata: neither the API nor the setup scripts
execute them. No credentials belong in these fields.

`POST /api/service-registrations` and MCP `service_register` take:

```json
{
  "id": "server-omlx-service",
  "device": "server",
  "name": "Local language models",
  "kind": "omlx",
  "binary": "/opt/bin/omlx",
  "platform": "macos",
  "mode": "server",
  "port": 8000,
  "address": "http://10.0.0.2:8000",
  "endpointId": "server-omlx",
  "watchId": "omlx"
}
```

Required fields: `id`, `device`, `name`, `kind`, `binary`, `platform`, `port`. `mode` defaults to `server`.
The caller needs `inventory:write`. To update, pass `base` from `inventory_get`; a stale or missing hash returns
409 and changes nothing. Updating preserves notes, dependencies and credential location pointers. New registrations
have `confidence:inferred`: registering metadata does not prove the process is running. Use the ordinary inventory
writer to record verified evidence or delete a registration with its hash.

## Setup on macOS, Linux and Windows

Node 22 or newer is required. Each wrapper calls the same zero-dependency setup program:

```sh
sh scripts/service-setup/macos.sh
sh scripts/service-setup/linux.sh
```

```powershell
powershell -File scripts/service-setup/windows.ps1
```

The script asks for the device ID, service ID, name, kind, installed binary path and port. Enter `none` for an
on-demand service. It prints a dry-run plan by default. On any OS, flags allow repeatable noninteractive setup:

```sh
node scripts/setup-service.mjs --device server --id server-omlx-service \
  --name "Local language models" --kind omlx --binary /opt/bin/omlx \
  --port 8000 --platform macos --endpoint-id server-omlx --watch-id omlx \
  --apply --hub https://hub.example.lan --token-file /path/to/api-key
```

The token file must belong to the current user and be private (0600 on Unix); its value is never printed.
`--token-stdin` is also supported. Tokens are never accepted as a command-line value. Remote hub connections require
HTTPS, use normal certificate validation and refuse redirects; HTTP is accepted only for loopback previews.
No files on the hub are edited directly: registration uses the authenticated API and its normal validation,
concurrency control and inventory writer. A failed request may have reached the hub; read the inventory before retrying.
The setup program does not install a daemon, run the binary, configure a model or enable a runtime endpoint.

## Supported kinds and adding one

`node scripts/setup-service.mjs --list-kinds` prints the authoritative list:
`generic`, `llama-swap`, `ollama`, `lmstudio`, `llama-cpp`, `vllm`, `sglang`, `omlx`, `mlx-serve`, `openai`, `mflux`.
Use `generic` for an otherwise supported service. These are registration types; live protocol support is separately
described in the runtime endpoint documentation. In particular, naming `mflux` does not imply an HTTP server.

Add another registration kind in `public/inventory-rules.js → SERVICE_KINDS`, add validation/setup coverage,
and document whether it serves a port or runs on demand. The API schema, CLI and inventory schema description
use that same list. A live reader is a separate runtime adapter or plugin provider; registration never invents one.
