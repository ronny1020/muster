# Muster's zsh startup shim — see zshenv.zsh for what these are for.
if [[ -n $MUSTER_PROFILE_RAN ]]; then
	builtin return
fi
MUSTER_PROFILE_RAN=1

if [[ $options[norcs] = off && -o login && -f $USER_ZDOTDIR/.zprofile ]]; then
	__muster_zdotdir=$ZDOTDIR
	ZDOTDIR=$USER_ZDOTDIR
	. $USER_ZDOTDIR/.zprofile
	ZDOTDIR=$__muster_zdotdir
	builtin unset __muster_zdotdir
fi
