// The rules of the software watch list that a machine checks too, not only the hub. A leaf module (it imports
// nothing), so the push agent (scripts/agent/) can check its local specs file with the very same constants
// (docs/agent.md → Leaf modules). server/software-watch.mjs re-exports them.

// The only arguments a cmd rule may pass to the watched binary. Anything else could make an arbitrary
// program do arbitrary things on the probed machine, so the collector refuses it too.
export const CMD_ARGS=Object.freeze(['--version','-version','-v','-V','version']);

// The Windows agent's detect kind (docs/agent.md → Windows: PowerShell only): winreg reads the machine-wide uninstall
// keys of the registry (HKLM, the 64- and 32-bit views) and matches a rule's displayName against each DisplayName,
// ignoring case. A display name is a few words; * stands for any run of characters and is the only wildcard. No quote,
// $, backquote, |, ;, &, <, >, parenthesis or bracket, so it never reads as syntax anywhere (the agent compares the
// pieces between the * as plain text, ignoring case, leftmost first and never by backtracking). At most four *.
export const WINREG_NAME=/^(?=[^ ])(?=.*[A-Za-z0-9])(?!.* $)(?!(?:[^*]*\*){5})[A-Za-z0-9 ._+,*-]{1,120}$/;
