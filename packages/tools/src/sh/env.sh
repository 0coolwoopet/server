#!/bin/sh
# Shared by the run-wrangler-* scripts. Source it, don't run it:
#
#   . "$(git rev-parse --show-toplevel)/packages/tools/src/sh/env.sh"
#
# It lives outside bin/ on purpose — package.json sets directories.bin to bin/, so anything
# in there becomes a runnable command in node_modules/.bin.
#
# RecFlare keeps a single gitignored .env at the repo root (see .env.example) holding
# everything an operator has to supply: their domain, the ids of the storage resources they
# created, and any tuning knobs they want to change. That one file feeds both `just deploy`
# and `just dev`, so a value is never configured twice.

# Names the deploy scripts consume themselves — the domain and the ids of the operator's
# Cloudflare resources. Everything else in .env is worker config; see recflare_vars.
RECFLARE_RESERVED="DOMAIN SUBDOMAINS D1 KV SECRETS_STORE ENV_LOADED STAFF_ACCOUNT_IDS RELOAD_CATALOG LOAD_CATALOG"

# Load the root .env, letting anything already in the environment win. The file is a local
# convenience; CI exports the same names as secrets and must not be clobbered by a stray
# .env in a checkout. Safe to call more than once.
recflare_load_env() {
	[ -z "${RECFLARE_ENV_LOADED:-}" ] || return 0
	RECFLARE_ENV_LOADED=1

	_env_file="$(git rev-parse --show-toplevel)/.env"
	[ -f "$_env_file" ] || return 0

	# `export -p` re-emits the already-exported values as quoted assignments, so we can put
	# them back after the file has had its say.
	_preset=$(export -p | grep -E '(^|[[:space:]])RECFLARE_[A-Za-z0-9_]+=' || true)
	set -a
	. "$_env_file"
	set +a
	eval "$_preset"

	unset _env_file _preset
}

# Echo the `--var` flags carrying the operator's tuning knobs, e.g.
# " --var MAX_ACCOUNTS_PER_IP:10 --var STARTING_TOKENS:250".
#
# This is a convention, not a list kept here: every RECFLARE_<VAR> in the environment that
# isn't one of the RECFLARE_RESERVED deploy inputs above is handed to the worker as
# `--var <VAR>:<value>`. So RECFLARE_MAX_ACCOUNTS_PER_IP=10 gives every worker
# MAX_ACCOUNTS_PER_IP=10 — the workers that don't read it simply ignore it, and two workers
# that read the same knob agree on it for free. Adding a knob means declaring it in the
# worker's context.ts, reading it there, and documenting it in .env.example; these scripts
# never need to change and stay free of any knowledge of specific app names.
#
# Every knob is optional: unset means no `--var` at all, so the worker falls back to the
# default constant in its own source, and deleting a line from .env really does restore that
# default on the next deploy. (Vars are replaced wholesale by a deploy — which is exactly
# why a value set in the Cloudflare dashboard doesn't survive one.)
#
# Values must not contain whitespace: the result is a flag list the caller word-splits.
# Knobs are numbers and short unquoted strings (`2=MyHub`), and real secrets belong in the
# Secrets Store (which is bound in wrangler.jsonc, not passed through here), so this hasn't
# been worth the ceremony of an array. Vars also arrive in the Worker as strings (`--var
# X:3` is "3", not 3), which is why a numeric knob is parsed through `intVar` rather than
# read as a number.
recflare_vars() {
	# The sed only ever yields [A-Z0-9_] names, so the eval below can't expand anything else.
	for _name in $(env | sed -n 's/^RECFLARE_\([A-Z0-9_][A-Z0-9_]*\)=.*/\1/p'); do
		case " $RECFLARE_RESERVED " in
		*" $_name "*) continue ;;
		esac

		eval "_value=\${RECFLARE_${_name}}"
		[ -n "$_value" ] || continue
		printf ' --var %s:%s' "$_name" "$_value"
	done

	unset _name _value
}

# Work out the base domain when the operator didn't set RECFLARE_DOMAIN.
#
# With no custom domain, workers live on the account's default workers.dev subdomain, so
# the base domain is "<account-subdomain>.workers.dev" and a worker named `api` is served at
# api.<account-subdomain>.workers.dev — exactly the "<subdomain>.<domain>" shape every
# worker (and the `ns` discovery document) already builds. The subdomain is looked up from
# the Cloudflare API with the same credentials wrangler deploys with. Best effort: if the
# lookup can't be done the caller reports that RECFLARE_DOMAIN has to be set by hand.
recflare_resolve_domain() {
	[ -z "${RECFLARE_DOMAIN:-}" ] || return 0
	[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || return 0

	_api="https://api.cloudflare.com/client/v4"
	_auth="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
	_acct=${CLOUDFLARE_ACCOUNT_ID:-}
	if [ -z "$_acct" ]; then
		# A token that sees exactly one account makes the account id unambiguous.
		_accts=$(curl -fsS -H "$_auth" "$_api/accounts" 2>/dev/null | jq -r '.result | map(.id) | if length == 1 then .[0] else empty end' 2>/dev/null || true)
		_acct=$_accts
	fi
	[ -n "$_acct" ] || return 0

	_sub=$(curl -fsS -H "$_auth" "$_api/accounts/$_acct/workers/subdomain" 2>/dev/null | jq -r '.result.subdomain // empty' 2>/dev/null || true)
	if [ -n "$_sub" ]; then
		RECFLARE_DOMAIN="$_sub.workers.dev"
		export RECFLARE_DOMAIN
	fi
	unset _api _auth _acct _accts _sub
}
