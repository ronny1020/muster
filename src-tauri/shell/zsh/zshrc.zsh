# Muster's zsh shell integration: the OSC 133 markers that tell the terminal
# where a prompt ends and a command's output begins.
#
# Reached through `ZDOTDIR` — see zshenv.zsh — so this file stands in for the
# user's `.zshrc` and has to source it before doing anything of its own.

builtin autoload -Uz add-zsh-hook

# A zsh started inside a Muster session inherits this, and its startup files
# are these shims. Hand `ZDOTDIR` back and leave the nested shell alone: one
# set of hooks per session is what makes each marker mean one thing.
if [[ -n $MUSTER_SHELL_INTEGRATION ]]; then
	ZDOTDIR=$USER_ZDOTDIR
	builtin return
fi
MUSTER_SHELL_INTEGRATION=1

# zsh derives `HISTFILE` from `ZDOTDIR`, which the injection has just moved —
# so without this a Muster session writes its history to a file no other
# terminal reads, and starts every first run with none.
HISTFILE=$USER_ZDOTDIR/.zsh_history

if [[ $options[norcs] = off && -f $USER_ZDOTDIR/.zshrc ]]; then
	__muster_zdotdir=$ZDOTDIR
	ZDOTDIR=$USER_ZDOTDIR
	# Sourced with the user's own `ZDOTDIR` in place: their `.zshrc` may look
	# beside itself for the rest of their configuration.
	. $USER_ZDOTDIR/.zshrc
	ZDOTDIR=$__muster_zdotdir
	builtin unset __muster_zdotdir
fi

# Where this shell keeps its history, after the user's own startup files have
# had their say about it. The terminal reads the file to suggest a command as
# you type, and guessing the path instead would be wrong for everyone who
# moved it.
#
# Only `\` and `;` need escaping: the sequence ends at the first BEL, and a
# path carrying one could not be opened anyway.
__muster_reported_history=
__muster_report_history() {
	if [[ -n $__muster_reported_history ]]; then
		builtin return
	fi
	__muster_reported_history=1
	builtin local path=${HISTFILE//\\/\\\\}
	builtin printf '\e]133;P;HistFile=%s\a' "${path//;/\\x3b}"
}

# What is about to run, as the shell itself has it.
#
# Read off the grid this was wrong for anyone with a right prompt: zsh draws
# `RPROMPT` on the command's own row, so the rendered row is the command, then
# padding, then the right prompt — and a suggestion built from it typed all
# three back into the shell.
__muster_report_command() {
	builtin local command=${1//\\/\\\\}
	builtin printf '\e]133;P;Cmd=%s\a' "${command//;/\\x3b}"
}

__muster_prompt_start() { builtin printf '\e]133;A\a' }
__muster_prompt_end() { builtin printf '\e]133;B\a' }
__muster_output_start() { builtin printf '\e]133;C\a' }

# Whether a command is running. Set at the start so the first prompt is
# wrapped like every later one.
__muster_running=1

# The prompt as the user's own configuration left it, so `preexec` can put it
# back before a command runs and `precmd` can wrap whatever the next one is.
# A prompt framework rewrites `PS1` on every turn, and this hook runs after
# it, so the wrap is applied to the prompt actually about to be drawn.
__muster_prior_prompt=
__muster_wrap_prompt() {
	__muster_prior_prompt=$PS1
	__muster_running=
	# `$(…)` is expanded here, at assignment, so the escape bytes are baked
	# into the prompt string rather than run on every redraw — and `%{…%}`
	# is what tells zsh they occupy no columns.
	PS1="%{$(__muster_prompt_start)%}$PS1%{$(__muster_prompt_end)%}"
}

__muster_precmd() {
	builtin local __muster_status=$?
	# Nothing ran — an empty line taken at the prompt — so open the section
	# the exit code below closes. Every D answers a C.
	if [[ -z $__muster_running ]]; then
		__muster_output_start
	fi
	builtin printf '\e]133;D;%s\a' "$__muster_status"
	if [[ -n $__muster_running ]]; then
		__muster_wrap_prompt
	fi
	__muster_report_history
}

__muster_preexec() {
	PS1=$__muster_prior_prompt
	__muster_running=1
	__muster_report_command "$1"
	__muster_output_start
}

add-zsh-hook precmd __muster_precmd
add-zsh-hook preexec __muster_preexec

# A non-login shell reads no `.zlogin`, so this is its last chance to hand
# `ZDOTDIR` back.
if [[ $options[login] = off ]]; then
	ZDOTDIR=$USER_ZDOTDIR
fi
