// What looks like a secret value rather than a description (the same idea as the inventory checker): machines,
// runtime stacks, integration settings and agent reports are shown to every signed-in reader and to agents, so
// none may hold one. A leaf module: it imports nothing, so the push agent (scripts/agent/) can check a line with
// the same rules as the hub before it sends it (docs/agent.md → Leaf modules). server/home-devices.mjs re-exports
// secretIn, where it was defined before.
//
// Each pattern is [regular expression, what it looks like, shape]. shape: true marks the two patterns that go by
// the form of a string alone (a long hex string, a long random-looking string). A version with a 40-hex commit, an
// image digest, a sudo digest rule or a public key trips them, so a field the agent report table calls "named" is
// checked without them (namedSecretIn).
export const SECRET_PATTERNS=Object.freeze([
 [/\bhh[ak]?_[a-f0-9]{64}\b/i,'a Home Hub access key',false],[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'a private key block',false],
 [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,'an API key',false],[/\b(ghp|gho|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/,'an access token',false],
 [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,'a JWT',false],[/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i,'an assignment of a secret',false],
 [/:\/\/[^/\s:@]+:[^/\s@]+@/,'credentials in a URL',false],[/\b[A-Fa-f0-9]{40,}\b/,'a long hex string',true],
 // No "/" or "-" in the run, so paths and model names never match.
 [/(?<![A-Za-z0-9+_])(?=[A-Za-z0-9+_]*\d)(?=[A-Za-z0-9+_]*[A-Z])(?=[A-Za-z0-9+_]*[a-z])[A-Za-z0-9+_]{32,}={0,2}(?![A-Za-z0-9+_])/,'a long random-looking string',true]].map(p=>Object.freeze(p)));

const first=(value,patterns)=>{if(typeof value!=='string')return null;for(const [re,why] of patterns)if(re.test(value))return why;return null;};
const NAMED=SECRET_PATTERNS.filter(p=>!p[2]);
// What the value looks like ("a JWT", …), or null. Never the value itself.
export const secretIn=value=>first(value,SECRET_PATTERNS);
// The same without the two shape patterns.
export const namedSecretIn=value=>first(value,NAMED);
