"""Node/libuv filesystem error spelling at the JSON service boundary."""

import errno
import os
import shutil
import stat as stat_mode
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import TracebackType
from typing import Any

_MESSAGES = {
    "EACCES": "permission denied",
    "EAGAIN": "resource temporarily unavailable",
    "EBADF": "bad file descriptor",
    "EBUSY": "resource busy or locked",
    "ECANCELED": "operation canceled",
    "EEXIST": "file already exists",
    "EFAULT": "bad address in system call argument",
    "EFBIG": "file too large",
    "EINTR": "interrupted system call",
    "EINVAL": "invalid argument",
    "EIO": "i/o error",
    "EISDIR": "illegal operation on a directory",
    "ELOOP": "too many symbolic links encountered",
    "EMFILE": "too many open files",
    "ENAMETOOLONG": "name too long",
    "ENFILE": "file table overflow",
    "ENODEV": "no such device",
    "ENOENT": "no such file or directory",
    "ENOMEM": "not enough memory",
    "ENOSPC": "no space left on device",
    "ENOSYS": "function not implemented",
    "ENOTDIR": "not a directory",
    "ENOTEMPTY": "directory not empty",
    "ENOTSUP": "operation not supported on socket",
    "EOVERFLOW": "value too large for defined data type",
    "EPERM": "operation not permitted",
    "EPIPE": "broken pipe",
    "ERANGE": "result too large",
    "EROFS": "read-only file system",
    "ESPIPE": "invalid seek",
    "ETIMEDOUT": "connection timed out",
    "ETXTBSY": "text file is busy",
    "EXDEV": "cross-device link not permitted",
    "ENXIO": "no such device or address",
    "EMLINK": "too many links",
    "ENOTTY": "inappropriate ioctl for device",
    "EILSEQ": "illegal byte sequence",
    "UNKNOWN": "unknown error",
}


class NodeFsError(OSError):
    def __init__(
        self,
        code: str,
        syscall: str,
        path: str | Path | None = None,
        dest: str | Path | None = None,
    ) -> None:
        self.code = code
        self.syscall = syscall
        self.path = str(path) if path is not None else None
        self.dest = str(dest) if dest is not None else None
        message = f"{code}: {_MESSAGES.get(code, 'unknown error')}, {syscall}"
        if self.path is not None:
            message += f" '{self.path}'"
        if self.dest is not None:
            message += f" -> '{self.dest}'"
        self.message = message
        super().__init__(getattr(errno, code, errno.EIO), message, self.path)

    def __str__(self) -> str:
        return self.message


class NodeFileNotFoundError(NodeFsError, FileNotFoundError):
    pass


class NodePermissionError(NodeFsError, PermissionError):
    pass


class NodePathError(TypeError):
    code = "ERR_INVALID_ARG_VALUE"


def validate_path(path: str | Path | None) -> None:
    if path is None or "\0" not in str(path):
        return
    # Node inspect chooses single quotes unless the value contains one.
    value = str(path)
    quote = "'" if "'" not in value else '"' if '"' not in value else "`"
    escapes = {"\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}
    encoded = "".join(
        "\\\\"
        if char == "\\"
        else escapes[char]
        if char in escapes
        else f"\\x{ord(char):02x}"
        if ord(char) < 32 or 127 <= ord(char) <= 159
        else "\\" + char
        if char == quote
        else char
        for char in value
    )
    raise NodePathError(
        "The argument 'path' must be a string, Uint8Array, or URL without null bytes. "
        f"Received {quote}{encoded}{quote}"
    )


def node_error(
    error: OSError, syscall: str, path: str | Path | None = None, dest: str | Path | None = None
) -> NodeFsError:
    code = errno.errorcode.get(error.errno or 0, "UNKNOWN")
    winerror = getattr(error, "winerror", None)
    if winerror in (5, 19, 32, 33, 65, 82):
        code = "EPERM" if winerror not in (32, 33) else "EBUSY"
    elif winerror in (2, 3, 123, 161):
        code = "ENOENT"
    elif winerror == 267:
        code = "ENOTDIR" if syscall in ("scandir", "mkdir", "rmdir") else "ENOENT"
    elif winerror == 206:
        code = "ENAMETOOLONG"
    if code == "EOPNOTSUPP":
        code = "ENOTSUP"
    if code == "ENOENT":
        return NodeFileNotFoundError(code, syscall, path, dest)
    if code in ("EPERM", "EACCES"):
        return NodePermissionError(code, syscall, path, dest)
    return NodeFsError(code, syscall, path, dest)


@contextmanager
def fs_operation(
    syscall: str, path: str | Path | None = None, dest: str | Path | None = None
) -> Iterator[None]:
    validate_path(path)
    validate_path(dest)
    try:
        yield
    except NodeFsError:
        raise
    except OSError as error:
        raise node_error(error, syscall, path, dest) from error


def read_bytes(path: str | Path) -> bytes:
    validate_path(path)
    if Path(path).is_dir():
        raise NodeFsError("EISDIR", "read")
    with fs_operation("open", path), Path(path).open("rb") as stream, fs_operation("read"):
        return stream.read()


def stat(path: str | Path) -> os.stat_result:
    with fs_operation("stat", path):
        return os.stat(path)


def mkdir(path: str | Path) -> None:
    validate_path(path)
    target = Path(path)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        # mkdir(recursive) reports the first existing non-directory ancestor.
        for parent in target.parents:
            if parent.is_file():
                raise NodeFsError("ENOTDIR", "mkdir", parent) from error
        raise node_error(error, "mkdir", target) from error


def scandir(path: str | Path) -> list[Path]:
    with fs_operation("scandir", path):
        return list(Path(path).iterdir())


def unlink(path: str | Path, *, missing_ok: bool = False) -> None:
    with fs_operation("unlink", path):
        Path(path).unlink(missing_ok=missing_ok)


def replace(source: str | Path, target: str | Path) -> None:
    with fs_operation("rename", source, target):
        os.replace(source, target)


def rm(path: str | Path, *, recursive: bool = False, force: bool = False) -> None:
    target = Path(path)
    try:
        with fs_operation("lstat", target):
            info = target.lstat()
    except FileNotFoundError:
        if force:
            return
        raise
    if stat_mode.S_ISDIR(info.st_mode):
        if not recursive:
            error = NodeFsError("EISDIR", "rm", target)
            error.code = "ERR_FS_EISDIR"
            error.message = f"Path is a directory: rm returned EISDIR (is a directory) {target}"
            raise error

        def recover(
            function: Any,
            filename: str,
            error_info: tuple[type[BaseException], BaseException, TracebackType],
        ) -> None:
            cause = error_info[1]
            if not isinstance(cause, OSError):
                raise cause
            syscall = "rmdir" if function is os.rmdir else "unlink"
            with fs_operation(syscall, filename):
                if os.name != "nt" or not isinstance(cause, PermissionError):
                    raise cause
                os.chmod(filename, 0o666)
                function(filename)

        with fs_operation("rmdir", target):
            shutil.rmtree(target, onerror=recover)
        return
    try:
        unlink(target, missing_ok=force)
    except NodePermissionError:
        if os.name != "nt":
            raise
        with fs_operation("chmod", target):
            os.chmod(target, 0o666)
        unlink(target, missing_ok=force)
