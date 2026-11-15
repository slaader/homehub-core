use serde_json::{Value, json};

pub const PROTOCOLS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

#[derive(Debug)]
pub enum Action {
    Immediate {
        status: u16,
        body: Option<Value>,
    },
    Initialize {
        id: Value,
        asked: Option<String>,
    },
    List {
        id: Value,
    },
    Call {
        id: Value,
        name: String,
        arguments: Value,
    },
    InvalidArguments {
        id: Value,
        name: String,
    },
}

pub fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
pub fn result(id: Value, value: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":value})
}
fn immediate(status: u16, value: Value) -> Action {
    Action::Immediate {
        status,
        body: Some(value),
    }
}
fn short(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(60)
        .collect()
}

/// Deliberately mirrors the existing endpoint's envelope acceptance, including null-id
/// notifications, ignored response messages, unsupported batches and permissive request ids.
/// It does not claim schema validation of business arguments (that is shared Node code).
pub fn parse(raw: &[u8]) -> Action {
    let msg: Value = match serde_json::from_str(&String::from_utf8_lossy(raw)) {
        Ok(value) => value,
        Err(_) => return immediate(400, error(Value::Null, -32700, "Parse error")),
    };
    if msg.is_array() {
        return immediate(
            400,
            error(Value::Null, -32600, "Batch requests are not supported."),
        );
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    if !msg.is_object()
        || msg.get("jsonrpc") != Some(&json!("2.0"))
        || !msg.get("method").is_some_and(Value::is_string)
    {
        if msg.is_object() && (msg.get("result").is_some() || msg.get("error").is_some()) {
            return Action::Immediate {
                status: 202,
                body: None,
            };
        }
        return immediate(400, error(id, -32600, "Invalid Request"));
    }
    if id.is_null() {
        return Action::Immediate {
            status: 202,
            body: None,
        };
    }
    let params = msg.get("params");
    match msg["method"].as_str().unwrap() {
        "initialize" => Action::Initialize {
            id,
            asked: params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        "ping" => immediate(200, result(id, json!({}))),
        "tools/list" => Action::List { id },
        "tools/call" => {
            let name = params.and_then(|p| p.get("name"));
            if !name.is_some_and(Value::is_string) {
                return immediate(
                    200,
                    error(id, -32602, &format!("Unknown tool: {}", short(name))),
                );
            }
            let arguments = params
                .and_then(|p| p.get("arguments"))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                // Preserve Node's unknown-name-before-invalid-arguments error precedence.
                return Action::InvalidArguments {
                    id,
                    name: name.unwrap().as_str().unwrap().to_owned(),
                };
            }
            Action::Call {
                id,
                name: name.unwrap().as_str().unwrap().to_owned(),
                arguments,
            }
        }
        _ => immediate(
            200,
            error(
                id,
                -32601,
                &format!("Method not found: {}", short(msg.get("method"))),
            ),
        ),
    }
}

impl Action {
    pub fn bridge_request(&self, authorization: &str) -> Value {
        let mut request = json!({"v":1,"authorization":authorization,"operation":"authenticate"});
        match self {
            Self::Initialize { .. } => request["operation"] = json!("initialize"),
            Self::List { .. } => request["operation"] = json!("list"),
            Self::Call {
                name, arguments, ..
            } => {
                request["operation"] = json!("call");
                request["name"] = json!(name);
                request["arguments"] = arguments.clone();
            }
            Self::Immediate { .. } => {}
            Self::InvalidArguments { name, .. } => {
                request["operation"] = json!("lookup");
                request["name"] = json!(name);
            }
        }
        request
    }

    /// Rust owns method dispatch, protocol selection and catalog scope filtering.
    /// Node returns initialization text/server identity and unfiltered live registry descriptors.
    pub fn finish(self, bridge: Value) -> (u16, Option<Value>) {
        let id = match &self {
            Self::Immediate { .. } => Value::Null,
            Self::Initialize { id, .. }
            | Self::List { id }
            | Self::Call { id, .. }
            | Self::InvalidArguments { id, .. } => id.clone(),
        };
        if bridge.get("ok") != Some(&Value::Bool(true)) {
            if bridge.get("status").and_then(Value::as_u64) == Some(401) {
                return (
                    401,
                    Some(
                        json!({"error":{"code":"AUTH_REQUIRED","message":"Use a service-account key: Authorization: Bearer hhk_…"}}),
                    ),
                );
            }
            let code = bridge
                .pointer("/error/code")
                .and_then(Value::as_i64)
                .unwrap_or(-32603);
            let message = bridge
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Internal error");
            return (200, Some(error(id, code, message)));
        }
        match self {
            Self::Immediate { status, body } => (status, body),
            Self::Initialize { id, asked } => {
                let version = asked
                    .as_deref()
                    .filter(|v| PROTOCOLS.contains(v))
                    .unwrap_or(PROTOCOLS[0]);
                let info = &bridge["result"];
                if !info["serverInfo"].is_object() || !info["instructions"].is_string() {
                    return (
                        502,
                        Some(error(id, -32603, "Invalid business bridge response")),
                    );
                }
                (
                    200,
                    Some(result(
                        id,
                        json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":info["serverInfo"],"instructions":info["instructions"]}),
                    )),
                )
            }
            Self::List { id } => {
                let Some(scopes) = bridge.pointer("/result/scopes").and_then(Value::as_array)
                else {
                    return (
                        502,
                        Some(error(id, -32603, "Invalid business bridge response")),
                    );
                };
                let Some(tools) = bridge.pointer("/result/tools").and_then(Value::as_array) else {
                    return (
                        502,
                        Some(error(id, -32603, "Invalid business bridge response")),
                    );
                };
                let visible: Vec<Value> = tools
                    .iter()
                    .filter(|tool| {
                        tool.get("scope")
                            .is_some_and(|scope| scopes.contains(scope))
                    })
                    .map(|tool| {
                        let mut tool = tool.clone();
                        if let Some(map) = tool.as_object_mut() {
                            map.remove("scope");
                        }
                        tool
                    })
                    .collect();
                (200, Some(result(id, json!({"tools":visible}))))
            }
            Self::Call { id, .. } => (200, Some(result(id, bridge["result"].clone()))),
            Self::InvalidArguments { id, name } => {
                let message = if bridge.pointer("/result/known") == Some(&Value::Bool(true)) {
                    "arguments must be an object".to_owned()
                } else {
                    format!("Unknown tool: {}", short(Some(&json!(name))))
                };
                (200, Some(error(id, -32602, &message)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(raw: &str) -> (u16, Option<Value>) {
        parse(raw.as_bytes()).finish(json!({"ok":true}))
    }
    #[test]
    fn envelopes_and_notifications() {
        assert_eq!(run("{").1.unwrap()["error"]["code"], -32700);
        assert_eq!(run("[]").0, 400);
        assert_eq!(run("null").1.unwrap()["error"]["code"], -32600);
        assert_eq!(
            run(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
            (202, None)
        );
        assert_eq!(
            run(r#"{"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"write"}}"#),
            (202, None)
        );
        assert_eq!(run(r#"{"id":4,"result":null}"#), (202, None));
        assert_eq!(
            run(r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#)
                .1
                .unwrap()["result"],
            json!({})
        );
        assert_eq!(
            run(r#"{"jsonrpc":"2.0","id":"x","method":"unknown"}"#)
                .1
                .unwrap()["error"]["code"],
            -32601
        );
    }
    #[test]
    fn protocol_negotiation_is_rust_owned() {
        for (asked, expected) in [("2025-03-26", "2025-03-26"), ("unknown", PROTOCOLS[0])] {
            let action = parse(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":asked}}).to_string().as_bytes());
            assert_eq!(
                action.bridge_request("Bearer example")["operation"],
                "initialize"
            );
            let out = action.finish(json!({"ok":true,"result":{"serverInfo":{"name":"home-hub","version":"test"},"instructions":"live"}}));
            assert_eq!(out.1.unwrap()["result"]["protocolVersion"], expected);
        }
    }
    #[test]
    fn live_catalog_scopes_and_annotations() {
        let action = parse(br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let out = action.finish(json!({"ok":true,"result":{"scopes":["read"],"tools":[{"name":"plugin_read","scope":"read","annotations":{"readOnlyHint":true}},{"name":"plugin_write","scope":"custom:write"}]}}));
        let tools = out.1.unwrap()["result"]["tools"].clone();
        assert_eq!(tools.as_array().unwrap().len(), 1);
        assert!(tools[0].get("scope").is_none());
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    }
    #[test]
    fn calls_pass_only_business_operation() {
        let action=parse(br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ticket_get","arguments":{"id":"APP-1"}}}"#);
        let request = action.bridge_request("Bearer example");
        assert_eq!(request["operation"], "call");
        assert!(request.get("method").is_none());
        assert_eq!(request["arguments"]["id"], "APP-1");
        let output = json!({"content":[{"type":"text","text":"scope refused"}],"isError":true});
        assert_eq!(
            action.finish(json!({"ok":true,"result":output})).1.unwrap()["result"],
            output
        );
        assert_eq!(run(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ticket_get","arguments":[]}}"#).1.unwrap()["error"]["code"],-32602);
    }
    #[test]
    fn auth_refusal_precedes_parse_error() {
        assert_eq!(parse(b"{").finish(json!({"ok":false,"status":401})).0, 401);
    }
}
