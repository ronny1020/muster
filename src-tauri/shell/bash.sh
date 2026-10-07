# Muster's bash shell integration: the OSC 133 markers that tell the terminal
# where a prompt ends and a command's output begins.
#
# Reached through `--init-file`, which stands in for the startup file bash
# would otherwise have read — so this file has to run that chain itself.

if [ -n "${MUSTER_SHELL_INTEGRATION:-}" ]; then
	builtin return
fi
MUSTER_SHELL_INTEGRATION=1

# `--init-file` and `-l` are mutually exclusive in bash: a login shell reads
# `/etc/profile` and the first of the three profiles below and never consults
# the init file at all. So the session is started without `-l` and the login
# chain is imitated here, which is the only way to have both. Without it a
# GUI-launched session has the bare `PATH` launchd or the desktop gave it.
if [ -n "${MUSTER_SHELL_LOGIN:-}" ]; then
	if [ -r /etc/profile ]; then
		. /etc/profile
	fi
	if [ -r ~/.bash_profile ]; then
		. ~/.bash_profile
	elif [ -r ~/.bash_login ]; then
		. ~/.bash_login
	elif [ -r ~/.profile ]; then
		. ~/.profile
	fi
	builtin unset MUSTER_SHELL_LOGIN
elif [ -r ~/.bashrc ]; then
	. ~/.bashrc
fi

# Where this shell keeps its history, after the user's own startup files have
# had their say about it. The terminal reads the file to suggest a command as
# you type, and guessing the path instead would be wrong for everyone who
# moved it. Reported once: the path is settled by the time the first prompt
# is drawn.
#
# Only `\` and `;` need escaping: the sequence ends at the first BEL, and a
# path carrying one could not be opened anyway.
__muster_reported_history=""
__muster_report_history() {
	if [ -n "$__muster_reported_history" ]; then
		builtin return
	fi
	__muster_reported_history="1"
	builtin local path="${HISTFILE//\\/\\\\}"
	builtin printf '\e]133;P;HistFile=%s\a' "${path//;/\\x3b}"
}

# What is about to run, as the shell itself has it — see the same function in
# the zsh script for why the rendered row is not good enough.
__muster_report_command() {
	builtin local command="${1//\\/\\\\}"
	builtin printf '\e]133;P;Cmd=%s\a' "${command//;/\\x3b}"
}

__muster_prompt_start() { builtin printf '\e]133;A\a'; }
__muster_prompt_end() { builtin printf '\e]133;B\a'; }
__muster_output_start() { builtin printf '\e]133;C\a'; }

# Whether a command is running, which is what keeps the DEBUG trap below from
# opening a second output section for each part of `PROMPT_COMMAND`.
__muster_running="0"

# The wrapped prompt as this last wrote it. Compared rather than remembered
# blindly: a prompt framework re-exports `PS1` on every turn, and a `PS1` that
# is no longer the wrapped one has to be wrapped again.
__muster_wrapped=""
__muster_wrap_prompt() {
	if [ "$__muster_wrapped" != "$PS1" ]; then
		# `\[…\]` is what tells bash the escape bytes occupy no columns.
		__muster_wrapped="\[$(__muster_prompt_start)\]$PS1\[$(__muster_prompt_end)\]"
		PS1="$__muster_wrapped"
	fi
}

__muster_precmd() {
	# Nothing ran — an empty line taken at the prompt — so open the section
	# the exit code below closes. Every D answers a C.
	if [ "$__muster_running" = "0" ]; then
		__muster_output_start
	fi
	builtin printf '\e]133;D;%s\a' "$__muster_status"
	__muster_running="0"
	__muster_wrap_prompt
	__muster_report_history
}

__muster_preexec() {
	if [ "$__muster_running" = "0" ]; then
		__muster_running="1"
		# `BASH_COMMAND` is the command about to run, with aliases already
		# resolved — which is what would be run again, so it is what to offer.
		# This file's own functions reach the trap too, since `PROMPT_COMMAND`
		# is a command like any other, and reporting one of those would offer
		# the terminal's plumbing as something the reader had typed.
		if [[ $BASH_COMMAND != __muster_* ]]; then
			__muster_report_command "$BASH_COMMAND"
		fi
		__muster_output_start
	fi
}

# `$?` has to be taken before anything else runs, and `PROMPT_COMMAND` may
# already hold the user's own — which expects to see that same code. So it is
# captured first, restored for the original, and read back in `__muster_precmd`.
__muster_restore_status() { builtin return "$1"; }

__muster_prompt_command() {
	__muster_status=$?
	__muster_precmd
}

# Copied as an array, never as a scalar: bash 5.1 made `PROMPT_COMMAND` an
# array, and `${PROMPT_COMMAND:-}` on one yields only its first element — so
# every later entry would be dropped for the life of the session, silently.
__muster_prior_prompt_command=("${PROMPT_COMMAND[@]}")
__muster_prompt_command_chained() {
	__muster_status=$?
	builtin local command
	__muster_restore_status "$__muster_status"
	for command in "${__muster_prior_prompt_command[@]}"; do
		builtin eval "${command:-}"
	done
	# Last, always: this is what closes the command and re-wraps the prompt,
	# and anything running after it would open an output section of its own.
	__muster_precmd
}

if [ -z "${bash_preexec_imported:-}" ]; then
	# Unset before assigning: on bash 5.1 `PROMPT_COMMAND` may be an array,
	# and `PROMPT_COMMAND=x` there sets only element 0 — leaving every later
	# entry live and running *after* this file's own hook, which has to be
	# last. Measured: the user's second entry then ran twice per prompt and
	# was reported as the command they had typed.
	builtin unset PROMPT_COMMAND
	if [ "${#__muster_prior_prompt_command[@]}" -gt 0 ]; then
		PROMPT_COMMAND=__muster_prompt_command_chained
	else
		PROMPT_COMMAND=__muster_prompt_command
	fi
fi

# Installed last, after everything else in this file has run: the trap fires
# for each command bash executes, including the remaining lines of this script
# — so setting it earlier reported one of them as the session's first command.
#
# The DEBUG trap is bash's only preexec, and something else may already hold
# it — starship and bash-preexec both do. Parsing it back out of `trap -p`
# needs the terms spliced into an expression rather than split on IFS, or a
# trap spanning lines or carrying quotes comes back mangled. The technique is
# VS Code's shell integration script (MIT).
__muster_debug_trap() {
	builtin local -a terms
	builtin eval "terms=( $(trap -p DEBUG) )"
	# terms=( trap -- '…the trap…' DEBUG )
	builtin printf '%s' "${terms[2]:-}"
}

if [ -n "${bash_preexec_imported:-}" ]; then
	# bash-preexec owns the DEBUG trap and offers these arrays instead.
	precmd_functions+=(__muster_prompt_command)
	preexec_functions+=(__muster_preexec)
else
	__muster_prior_trap="$(__muster_debug_trap)"
	if [ -z "$__muster_prior_trap" ]; then
		trap '__muster_preexec' DEBUG
	elif [ "$__muster_prior_trap" != '__muster_preexec' ] &&
		[ "$__muster_prior_trap" != '__muster_preexec_chained' ]; then
		__muster_preexec_chained() {
			__muster_preexec
			builtin eval "$__muster_prior_trap"
		}
		trap '__muster_preexec_chained' DEBUG
	fi
fi
