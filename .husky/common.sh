#!/bin/sh

command_exists () {
  command -v "$1" >/dev/null 2>&1
}

IS_WINDOWS="false"

if [ "$OSTYPE" = "cygwin" ]; then
    IS_WINDOWS="true"
elif [ "$OSTYPE" = "msys" ]; then
    IS_WINDOWS="true"
elif [ "$OSTYPE" = "win32" ]; then
    IS_WINDOWS="true"
fi

# Workaround for Windows 10, Git Bash and Yarn
if [ "$IS_WINDOWS" = "true" ]; then
    if command_exists winpty && test -t 1; then
        exec < /dev/tty
    fi
fi
