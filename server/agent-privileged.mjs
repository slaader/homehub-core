// Every privileged read the push agent's probes make, per platform, with full paths (docs/agent.md → The
// privileged list). One constant: the installer renders the sudoers rules from it, the probes call exactly these
// lines as literals, and a report's `PRIV <id> ok|denied` line names one of its ids (server/agent-report.mjs).
// A leaf module: it imports nothing.
//
// An entry: {id, argv, alternative?, only?}. Several entries may share an id (Linux `listen`: the probe tries the
// paths in this order, and the installer writes a rule for each one that exists, is root-owned and is not writable
// by others; alternative: true marks them). only: "all-accounts" = the rule exists only when the agent is installed
// with --keys all-accounts (the security probe run as root, from a root-owned copy).
const entry=(id,argv,extra={})=>Object.freeze({id,argv:Object.freeze(argv),...extra});
const SSH_PROBE=entry('ssh-probe',['/usr/local/libexec/home-hub-agent/ssh-probe.sh'],{only:'all-accounts'});
export const PRIVILEGED=Object.freeze({
 macos:Object.freeze([
  entry('pf-info',['/sbin/pfctl','-s','info']),
  entry('pf-rules',['/sbin/pfctl','-s','rules']),
  entry('listen',['/usr/sbin/lsof','+c','0','-nP','-iTCP','-sTCP:LISTEN']),
  entry('sshd',['/usr/sbin/sshd','-T']),
  SSH_PROBE]),
 linux:Object.freeze([
  entry('sshd',['/usr/sbin/sshd','-T']),
  entry('nft',['/usr/sbin/nft','list','ruleset']),
  entry('listen',['/usr/bin/ss','-Htlnp'],{alternative:true}),
  entry('listen',['/usr/sbin/ss','-Htlnp'],{alternative:true}),
  entry('listen',['/bin/ss','-Htlnp'],{alternative:true}),
  SSH_PROBE]),
 // Windows runs no sudo: its agent has no privileged list in this series.
 windows:Object.freeze([]),
});
// The ids a platform's PRIV lines may name.
export const privilegedIds=platform=>[...new Set((PRIVILEGED[platform]||[]).map(e=>e.id))];
