# Muster's zsh startup shim — see src-tauri/src/shell.rs.
#
# `ZDOTDIR` points every one of zsh's startup files at this directory, so each
# shim's first job is to hand control back to the user's own. `USER_ZDOTDIR` is
# re-read afterwards because the file just sourced may have set `ZDOTDIR`
# itself, and that new value is the one the later shims have to source from.
if [[ -f $USER_ZDOTDIR/.zshenv ]]; then
	__muster_zdotdir=$ZDOTDIR
	ZDOTDIR=$USER_ZDOTDIR
	# A `ZDOTDIR` already pointing here means this shim is about to source
	# itself.
	if [[ $USER_ZDOTDIR != $__muster_zdotdir ]]; then
		. $USER_ZDOTDIR/.zshenv
	fi
	USER_ZDOTDIR=$ZDOTDIR
	ZDOTDIR=$__muster_zdotdir
	builtin unset __muster_zdotdir
fi
