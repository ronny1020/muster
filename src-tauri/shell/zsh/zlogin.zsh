# Muster's zsh startup shim — see zshenv.zsh for what these are for.
#
# The last file zsh reads, so this is where `ZDOTDIR` goes back for good: a
# shell started inside this session is the user's own and must read their
# startup files, not these.
if [[ -n $MUSTER_LOGIN_RAN ]]; then
	builtin return
fi
MUSTER_LOGIN_RAN=1

ZDOTDIR=$USER_ZDOTDIR
if [[ $options[norcs] = off && -o login && -f $ZDOTDIR/.zlogin ]]; then
	. $ZDOTDIR/.zlogin
fi
