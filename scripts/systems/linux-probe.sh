#!/bin/sh
# Home Hub systems probe for Linux: the push agent's Linux probe (docs/agent.md section 5). Read-only. One
# tab-separated record per line on stdout, ending with "END<TAB>ok":
#   HOST                           host, platform, account, root (1 only for a root run), probe time
#   OS, HW, UPTIME                 distribution, version, base, kernel, arch; model, CPU, memory, cpus; seconds up
#   AUTO                           unattended-update policy, read from the apt or dnf-automatic configuration
#   SSHD                           effective sshd settings (sshd -T, privileged; "effective unknown" without it)
#   LISTEN                         listening TCP sockets; the owning process is named only through the privileged ss read
#   NFT                            input-hook policies, rule count and tables (nft, privileged; "unknown" without it)
#   PRIV <id> ok|denied            each privileged read: nft, listen, sshd
#   PKGUP, PKGUP_NONE, PKGUP_ERR   pending updates from the package manager's cached index (apt; dnf or yum, which
#                                  are labelled dnf). pacman, zypper and apk have no record form here and read nothing
#   SW, RUN                        watched software from $SPECS (id|kind|arg1|arg2|unit): cmd, json and pydist are read,
#                                  other kinds read "unsupported"; RUN is systemctl show of the unit in field 5
#   DOCKER                         running containers, when the account may reach docker
#   ERROR                          a condition the page shows (no timeout(1) on the host: nothing runs)
#
# Nothing here installs, upgrades, refreshes a package index or writes a file: no apt-get update, no dnf makecache,
# no check-update without -C. Privileged reads go only through R, as sudo -n with the full path that the agent's
# sudo rules name (the Linux rows of the privileged list in docs/agent.md section 5). Every tool the probe runs,
# and every read of a watch-list path, runs under timeout(1); a missing tool gives the record's absent or unknown
# form, never an error exit. Without timeout(1) the probe says so (ERROR) and stops. PATH is the caller's (the
# agent passes a fixed one). SPECS is the caller's watch list.
set -u
LC_ALL=C
export LC_ALL
: "${SPECS:=}"
: "${HOME:=/nonexistent}"
TAB=$(printf '\t')

# --- helpers --------------------------------------------------------------------------------------
# T SECONDS COMMAND...: the command under timeout(1). Without timeout(1) nothing runs (status 127).
T() {
  _t_secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$_t_secs" "$@"; else return 127; fi
}
# R COMMAND ARGS...: one privileged read, as sudo -n. Only the commands of the privileged list are passed here.
R() { T 60 sudo -n "$@"; }
# emit TAG FIELD...: one record. Every control character (tab and line breaks included) in a field becomes a space,
# and every byte above 127 a "?", so a field is plain ASCII and never a cut-up UTF-8 sequence (LC_ALL=C: bytes).
emit() {
  _emit_out=$1; shift
  for _emit_field in "$@"; do
    _emit_out="$_emit_out$TAB$(printf '%s' "$_emit_field" | tr '\001-\037\177' ' ' | tr '\200-\377' '?')"
  done
  printf '%s\n' "$_emit_out"
}
# clip N TEXT: the first N characters (the record fields have limits).
clip() { printf "%.${1}s" "$2"; }
# priv ID ok|denied: a PRIV record.
priv() { emit PRIV "$1" "$2"; }
# first_line FILE: the first line of a file, read by the shell; nothing when it cannot be read.
first_line() {
  _fl_line=
  read -r _fl_line 2>/dev/null <"$1" || :
  printf '%s' "$_fl_line"
}
# osr KEY: a value of /etc/os-release, read as text and never sourced.
osr() {
  awk -F= -v k="$1" '$1 == k { v = $2; gsub(/"/, "", v); print v; exit }' /etc/os-release 2>/dev/null
}
# age_of MTIME: seconds since an epoch time; nothing when either time is unknown.
age_of() {
  _ao_now=$(T 5 date +%s </dev/null 2>/dev/null)
  case $1 in ''|*[!0-9]*) return 0;; esac
  case $_ao_now in ''|*[!0-9]*) return 0;; esac
  printf '%s' "$((_ao_now - $1))"
}
# dnf_cache_age: seconds since the newest cached repository metadata was written.
dnf_cache_age() {
  _dc_m=$(T 5 stat -c %Y /var/cache/dnf/*/repodata/repomd.xml </dev/null 2>/dev/null | sort -rn | head -1)
  [ -n "$_dc_m" ] || _dc_m=$(T 5 stat -c %Y /var/cache/libdnf5 </dev/null 2>/dev/null)
  age_of "$_dc_m"
}
# expand_home PATH: a leading ~/ becomes the account's home.
expand_home() {
  case $1 in "~/"*) printf '%s/%s' "$HOME" "${1#\~/}";; *) printf '%s' "$1";; esac
}
# ss_rows: "process|address" per listening socket, from ss -H output on stdin (sorted, no repeats).
ss_rows() {
  awk 'NF >= 4 {
    proc = $0
    if (sub(/.*users:\(\("/, "", proc)) sub(/".*/, "", proc); else proc = "?"
    gsub(/\|/, " ", proc)
    if (proc == "") proc = "?"
    print proc "|" $4
  }' | sort -u
}
# ss_listen: LISTEN records from ss_rows on stdin. The account of a socket's owner is not read: "?".
ss_listen() {
  while IFS='|' read -r _sl_proc _sl_addr; do
    emit LISTEN "$(clip 60 "$_sl_proc")" "?" "$(clip 64 "$_sl_addr")"
  done
}
# dnf_rows: "name|candidate" per pending update, from dnf check-update output on stdin. The arch suffix is
# dropped and a name wrapped onto its own line is joined to its version line.
dnf_rows() {
  awk '
    /^Obsoleting/ { exit }
    NF == 1 && pend == "" { pend = $1; next }
    pend != "" { $0 = pend " " $0; pend = "" }
    NF == 3 && $1 ~ /\./ { name = $1; sub(/\.[^.]*$/, "", name); print name "|" $2 }
  '
}
# run_unit ID UNIT: a RUN record from systemctl show (unprivileged). Absent when the unit is not installed,
# the pid when it is active, loaded when it is installed and not running. Nothing when systemctl cannot say.
run_unit() {
  # "--" ends systemctl's options, so a unit field that starts with a dash is a unit name, never an option.
  _ru_st=$(T 10 systemctl show -p MainPID,ActiveState,LoadState -- "$2" </dev/null 2>/dev/null) || return 0
  _ru_load=$(printf '%s\n' "$_ru_st" | awk -F= '$1 == "LoadState" { print $2 }')
  _ru_active=$(printf '%s\n' "$_ru_st" | awk -F= '$1 == "ActiveState" { print $2 }')
  _ru_pid=$(printf '%s\n' "$_ru_st" | awk -F= '$1 == "MainPID" { print $2 }')
  [ -n "$_ru_load" ] || return 0
  case $_ru_pid in ''|*[!0-9]*) _ru_pid=0;; esac
  if [ "$_ru_load" = not-found ]; then emit RUN "$1" absent "$(clip 120 "$2")"; return 0; fi
  if [ "$_ru_active" = active ] && [ "$_ru_pid" -gt 0 ]; then emit RUN "$1" "$_ru_pid" "$(clip 120 "$2")"
  else emit RUN "$1" loaded "$(clip 120 "$2")"; fi
}

# --- package updates from the cached index ----------------------------------------------------------
# apt: the index already on the host. Its presence is a package list file (*_Packages*) under /var/lib/apt/lists,
# and its age is the newest of them. apt-cache stats is not used: it counts the installed packages too, so it is
# not evidence of an index. apt list reads the index and never refreshes it.
pkgup_apt() {
  _pa_mtime=$(T 5 stat -c %Y /var/lib/apt/lists/*_Packages* </dev/null 2>/dev/null | sort -rn | head -1)
  [ -n "$_pa_mtime" ] || { emit PKGUP_ERR apt "no package index on this host (/var/lib/apt/lists)"; return 0; }
  _pa_out=$(T 120 apt list --upgradable </dev/null 2>/dev/null); _pa_rc=$?
  if [ "$_pa_rc" != 0 ]; then emit PKGUP_ERR apt "$(clip 200 "apt list exited $_pa_rc")"; return 0; fi
  _pa_rows=$(printf '%s\n' "$_pa_out" | awk 'index($0, "[upgradable from: ") {
    split($1, nm, "/"); inst = $0
    sub(/.*\[upgradable from: /, "", inst); sub(/\]$/, "", inst)
    print nm[1] "|" inst "|" $2 "|" (nm[2] ~ /-security/ ? 1 : 0)
  }')
  if [ -z "$_pa_rows" ]; then emit PKGUP_NONE apt "$(age_of "$_pa_mtime")"; return 0; fi
  printf '%s\n' "$_pa_rows" | while IFS='|' read -r _pa_name _pa_inst _pa_cand _pa_sec; do
    emit PKGUP apt "$(clip 120 "$_pa_name")" "$(clip 80 "$_pa_inst")" "$(clip 80 "$_pa_cand")" "$_pa_sec"
  done
}
# dnf or yum: check-update with -C (the cache only). Exit 0 is none pending, 100 is some, anything else an error.
# The security set is a second cached check-update, with --security after the command (dnf4, dnf5 and yum all take
# it there; dnf5 refuses a command-specific option before the command). A name in it is marked 1. A failed security
# read is an error, not a silent 0: without it the security flags are unknown.
pkgup_dnf() {
  _pd_out=$(T 120 "$1" -C check-update </dev/null 2>/dev/null); _pd_rc=$?
  case $_pd_rc in
    0) emit PKGUP_NONE dnf "$(dnf_cache_age)"; return 0;;
    100) ;;
    *) emit PKGUP_ERR dnf "$(clip 200 "$1 -C check-update exited $_pd_rc")"; return 0;;
  esac
  _pd_sec_out=$(T 120 "$1" -C check-update --security </dev/null 2>/dev/null); _pd_sec_rc=$?
  case $_pd_sec_rc in
    0|100) ;;
    *) emit PKGUP_ERR dnf "$(clip 200 "$1 -C check-update --security exited $_pd_sec_rc")"; return 0;;
  esac
  _pd_sec=$(printf '%s\n' "$_pd_sec_out" | dnf_rows | cut -d'|' -f1 | tr '\n' ' ')
  _pd_rows=$(printf '%s\n' "$_pd_out" | dnf_rows | awk -F'|' -v sec=" $_pd_sec " '{ print $1 "|" $2 "|" (index(sec, " " $1 " ") ? 1 : 0) }')
  if [ -z "$_pd_rows" ]; then emit PKGUP_ERR dnf "check-update listed no update that could be read"; return 0; fi
  printf '%s\n' "$_pd_rows" | while IFS='|' read -r _pd_name _pd_cand _pd_isec; do
    emit PKGUP dnf "$(clip 120 "$_pd_name")" "" "$(clip 80 "$_pd_cand")" "$_pd_isec"
  done
}

# --- record: host ---------------------------------------------------------------------------------
ME_UID=$(awk '/^Uid:/ { print $2; exit }' /proc/self/status 2>/dev/null)
ME_NAME=
[ -n "$ME_UID" ] && ME_NAME=$(awk -F: -v u="$ME_UID" '$3 == u { print $1; exit }' /etc/passwd 2>/dev/null)
ROOT=0; [ "$ME_UID" = 0 ] && ROOT=1
HOST_NAME=$(first_line /proc/sys/kernel/hostname)
TIME=$(T 5 date -u +%Y-%m-%dT%H:%M:%SZ </dev/null 2>/dev/null)
emit HOST "$(clip 64 "${HOST_NAME%%.*}")" Linux "$(clip 64 "$ME_NAME")" "$ROOT" "$TIME"
# Without timeout(1) no tool may run (T would refuse each one, and every read would look denied): say so and stop.
# The HOST record then has no probe time, which is why the agent does not send such a report.
if ! command -v timeout >/dev/null 2>&1; then
  emit ERROR "timeout(1) is not installed: no command of this probe ran"
  emit END ok
  exit 0
fi

# --- record: operating system and hardware ----------------------------------------------------------
KERNEL=$(first_line /proc/sys/kernel/osrelease)
ARCH=$(T 5 uname -m </dev/null 2>/dev/null)
emit OS "$(clip 40 "$(osr NAME)")" "$(clip 20 "$(osr VERSION_ID)")" "$(clip 80 "$(osr PRETTY_NAME)")" "$(clip 60 "$KERNEL")" "$(clip 20 "$ARCH")"
MODEL=$(first_line /sys/devices/virtual/dmi/id/product_name)
CPU=$(awk -F': ' '/^model name/ { print $2; exit }' /proc/cpuinfo 2>/dev/null)
MEM=$(awk '/^MemTotal:/ { printf "%.0f\n", $2 * 1024; exit }' /proc/meminfo 2>/dev/null)
CPUS=$(awk '/^processor/ { n++ } END { if (n) print n }' /proc/cpuinfo 2>/dev/null)
emit HW "$(clip 60 "$MODEL")" "$(clip 80 "$CPU")" "$MEM" "$CPUS"
UPTIME_RAW=$(first_line /proc/uptime)
emit UPTIME "${UPTIME_RAW%%.*}"

# The package manager: apt first (Debian, Ubuntu), then dnf, then yum (RHEL 7 and its kin).
PM=none
if command -v apt >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum; fi

case $PM in
  apt)
    _au=$(awk -F'"' '/Unattended-Upgrade/ { print $2; exit }' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null)
    emit AUTO unattended-upgrade "$(clip 20 "${_au:-unset}")";;
  dnf|yum)
    _au=$(awk -F= '/^[[:space:]]*apply_updates[[:space:]]*=/ { gsub(/[[:space:]]/, "", $2); print $2; exit }' /etc/dnf/automatic.conf 2>/dev/null)
    emit AUTO dnf-automatic-apply "$(clip 20 "${_au:-unset}")";;
esac

# --- record: host protection --------------------------------------------------------------------------
if sshd_t=$(R /usr/sbin/sshd -T </dev/null 2>/dev/null); then
  priv sshd ok
  printf '%s\n' "$sshd_t" | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|allowusers|allowtcpforwarding) ' \
    | while IFS=' ' read -r _ss_k _ss_v; do emit SSHD "$(clip 40 "$_ss_k")" "$(clip 120 "$_ss_v")"; done
else
  priv sshd denied
  emit SSHD effective unknown
fi

# Listening sockets: ss -p through the privileged list (the first of the three paths that exists), else ss -n
# without the process. Either way the owner's account is not read, so it is "?".
if ss_out=$(R /usr/bin/ss -Htlnp </dev/null 2>/dev/null) || ss_out=$(R /usr/sbin/ss -Htlnp </dev/null 2>/dev/null) || ss_out=$(R /bin/ss -Htlnp </dev/null 2>/dev/null); then
  priv listen ok
  printf '%s\n' "$ss_out" | ss_rows | ss_listen
else
  priv listen denied
  T 10 ss -Htln </dev/null 2>/dev/null | ss_rows | ss_listen
fi

if nft_out=$(R /usr/sbin/nft list ruleset </dev/null 2>/dev/null); then
  priv nft ok
  nft_policies=$(printf '%s\n' "$nft_out" | grep 'hook input' | sed -n 's/.*policy \([a-z]*\);.*/\1/p' | sort | uniq -c \
    | awk '{ s = s (s == "" ? "" : " ") $2 ":" $1 } END { print s }')
  nft_rules=$(printf '%s\n' "$nft_out" | grep -cE '^[[:space:]]+(ip|ip6|tcp|udp|ct|iif|iifname|oif|oifname|meta|counter|jump|goto|accept|drop|reject|th)([[:space:]]|$)')
  nft_tables=$(printf '%s\n' "$nft_out" | awk '$1 == "table" { t = t (t == "" ? "" : ",") $2 " " $3 } END { print t }')
  emit NFT "$(clip 80 "${nft_policies:-none}")" "$nft_rules" "$(clip 400 "$nft_tables")"
else
  priv nft denied
  emit NFT unknown
fi

# --- record: package updates --------------------------------------------------------------------------
case $PM in
  apt) pkgup_apt;;
  dnf|yum) pkgup_dnf "$PM";;
  *) ;;
esac

# --- record: watched software -------------------------------------------------------------------------
# One SPECS line per item: id|kind|arg1|arg2|unit. The lines reach the loop through a pipe, not a here-document: bash
# writes a here-document to a temporary file when it is larger than a pipe buffer or the shell is bash 4.4 (RHEL 8),
# and a unit with ProtectSystem=strict may not write there. The loop would then read nothing and the report would
# still end "END ok", so the watch list would vanish without an error.
# Nothing in a line is run as shell code: each one is only read into variables and used as an argument. A path is
# one word unless it holds a glob (* or ?), which is expanded; a path with a space is one candidate, as it is in
# mac-probe.sh. The paths are set as the positional parameters, and IFS is a newline only for the glob expansion.
printf '%s\n' "$SPECS" | while IFS='|' read -r w_id w_kind w_a w_b w_unit; do
  [ -n "$w_id" ] || continue
  case $w_kind in
    cmd)
      w_pat=$(expand_home "$w_a"); w_hits=0
      case $w_pat in
        *'*'*|*'?'*) w_ifs=$IFS; IFS='
'; set -- $w_pat; IFS=$w_ifs;;
        *) set -- "$w_pat";;
      esac
      for w_bin do
        [ -x "$w_bin" ] || continue
        w_hits=$((w_hits + 1))
        # The argument is one word, quoted: a value cannot add arguments (no word splitting, no globbing).
        w_out=$(T 20 "$w_bin" ${w_b:+"$w_b"} </dev/null 2>&1 | awk 'NF { s = s (s == "" ? "" : " ") $0; n++; if (n == 3) exit } END { print s }')
        emit SW "$w_id" cmd "$(clip 300 "$w_out")" "$(clip 300 "$w_bin")"
      done
      if [ "$w_hits" = 0 ]; then emit SW "$w_id" missing "" "$(clip 300 "$w_pat")"; fi;;
    pydist)
      w_norm=$(printf '%s' "$w_b" | tr 'A-Z-' 'a-z_'); w_hits=0
      w_sites=$(expand_home "$w_a")
      case $w_sites in
        *'*'*|*'?'*) w_ifs=$IFS; IFS='
'; set -- $w_sites; IFS=$w_ifs;;
        *) set -- "$w_sites";;
      esac
      for w_site do
        for w_d in "$w_site"/*.dist-info; do
          [ -d "$w_d" ] || continue
          w_base=${w_d##*/}; w_base=${w_base%.dist-info}
          w_name=$(printf '%s' "${w_base%-*}" | tr 'A-Z-' 'a-z_')
          [ "$w_name" = "$w_norm" ] || continue
          w_hits=$((w_hits + 1))
          emit SW "$w_id" pydist "$(clip 300 "${w_base##*-}")" "$(clip 300 "$w_site")"
        done
      done
      if [ "$w_hits" = 0 ]; then emit SW "$w_id" missing "" "$(clip 300 "$w_a")"; fi;;
    json)
      w_file=$(expand_home "$w_a"); w_ver=
      # A regular file only: a device such as /dev/zero would never end. The read is under timeout(1), and "--"
      # keeps a path that starts with a dash from being read as an option.
      if [ -f "$w_file" ]; then
        w_ver=$(T 10 grep -o -e "\"${w_b:-version}\" *: *\"[^\"]*\"" -- "$w_file" </dev/null 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"/\1/')
      fi
      if [ -n "$w_ver" ]; then emit SW "$w_id" json "$(clip 300 "$w_ver")" "$(clip 300 "$w_file")"
      else emit SW "$w_id" missing "" "$(clip 300 "$w_file")"; fi;;
    *) emit SW "$w_id" unsupported "" "$(clip 300 "$w_kind")";;
  esac
  if [ -n "$w_unit" ]; then run_unit "$w_id" "$w_unit"; fi
done

# --- record: containers ---------------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  T 15 docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' </dev/null 2>/dev/null | while IFS='|' read -r d_name d_image d_status; do
    d_created=$(T 10 docker image inspect --format '{{.Created}}' "$d_image" </dev/null 2>/dev/null)
    emit DOCKER "$(clip 80 "$d_name")" "$(clip 160 "$d_image")" "$(clip 80 "$d_status")" "$(clip 40 "$d_created")"
  done
fi

emit END ok
exit 0
