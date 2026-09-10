"""V8 JSON syntax diagnostics, including UTF-16 locations and context excerpts."""

from __future__ import annotations

import re
from typing import NoReturn


class JsonSyntaxError(ValueError):
    name = "SyntaxError"


class _Scanner:
    def __init__(self, source: str) -> None:
        raw = source.encode("utf-16-le", "surrogatepass")
        self.source = "".join(
            chr(raw[index] | raw[index + 1] << 8) for index in range(0, len(raw), 2)
        )
        self.position = 0

    def fail(self, message: str, *, location: bool = True) -> NoReturn:
        if location:
            before = self.source[: self.position]
            lines = re.split(r"\r\n|\r|\n", before)
            if not message.endswith("JSON"):
                message += " in JSON"
            message += (
                f" at position {self.position} (line {len(lines)} column {len(lines[-1]) + 1})"
            )
        # A JS string stores code units. Combine valid surrogate pairs for Python callers.
        message = message.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
        raise JsonSyntaxError(message)

    def unexpected(self) -> NoReturn:
        if self.position == len(self.source):
            self.fail("Unexpected end of JSON input", location=False)
        if self.source in {"undefined", "NaN", "Infinity", "[object Object]"}:
            self.fail(f'"{self.source}" is not valid JSON', location=False)
        token = self.source[self.position]
        if token in "-0123456789":
            self.fail("Unexpected number")
        if token == '"':
            self.fail("Unexpected string")
        if len(self.source) <= 20:
            excerpt = f'"{self.source}"'
        else:
            begin = max(self.position - 10, 0)
            end = min(self.position + 10, len(self.source))
            excerpt = ("..." if self.position >= 10 else "") + f'"{self.source[begin:end]}"'
            if end < len(self.source):
                excerpt += "..."
        self.fail(f"Unexpected token '{token}', {excerpt} is not valid JSON", location=False)

    def peek(self) -> str:
        return self.source[self.position] if self.position < len(self.source) else ""

    def whitespace(self) -> None:
        while self.peek() and self.peek() in " \t\n\r":
            self.position += 1

    def string(self) -> None:
        self.position += 1
        while self.peek():
            char = self.peek()
            if char == '"':
                self.position += 1
                return
            if ord(char) < 32:
                self.fail("Bad control character in string literal")
            if char == "\\":
                self.position += 1
                char = self.peek()
                if not char:
                    self.unexpected()
                if char == "u":
                    for _ in range(4):
                        self.position += 1
                        if not self.peek() or self.peek() not in "0123456789abcdefABCDEF":
                            self.fail("Bad Unicode escape")
                elif char not in '"\\/bfnrt':
                    self.fail("Bad escaped character")
            self.position += 1
        self.fail("Unterminated string")

    def digits(self) -> None:
        while self.peek() and self.peek() in "0123456789":
            self.position += 1

    def number(self) -> None:
        if self.peek() == "-":
            self.position += 1
            if not self.peek() or self.peek() not in "0123456789":
                self.fail("No number after minus sign")
        if self.peek() == "0":
            self.position += 1
            if self.peek() and self.peek() in "0123456789":
                self.fail("Unexpected number")
        else:
            self.digits()
        if self.peek() == ".":
            self.position += 1
            if not self.peek() or self.peek() not in "0123456789":
                self.fail("Unterminated fractional number")
            self.digits()
        if self.peek() and self.peek() in "eE":
            self.position += 1
            if self.peek() and self.peek() in "+-":
                self.position += 1
            if not self.peek() or self.peek() not in "0123456789":
                self.fail("Exponent part is missing a number")
            self.digits()

    def value(self) -> None:
        self.whitespace()
        char = self.peek()
        if char == '"':
            self.string()
        elif char and char in "-0123456789":
            self.number()
        elif char == "{":
            self.object()
        elif char == "[":
            self.array()
        elif char and char in "tfn":
            literal = {"t": "true", "f": "false", "n": "null"}[char]
            for expected in literal:
                if self.peek() != expected:
                    self.unexpected()
                self.position += 1
        else:
            self.unexpected()

    def object(self) -> None:
        self.position += 1
        self.whitespace()
        if self.peek() == "}":
            self.position += 1
            return
        if self.peek() != '"':
            self.fail("Expected property name or '}'")
        while True:
            self.string()
            self.whitespace()
            if self.peek() != ":":
                self.fail("Expected ':' after property name")
            self.position += 1
            self.value()
            self.whitespace()
            if self.peek() == "}":
                self.position += 1
                return
            if self.peek() != ",":
                self.fail("Expected ',' or '}' after property value")
            self.position += 1
            self.whitespace()
            if self.peek() != '"':
                self.fail("Expected double-quoted property name")

    def array(self) -> None:
        self.position += 1
        self.whitespace()
        if self.peek() == "]":
            self.position += 1
            return
        while True:
            self.value()
            self.whitespace()
            if self.peek() == "]":
                self.position += 1
                return
            if self.peek() != ",":
                self.fail("Expected ',' or ']' after array element")
            self.position += 1


def syntax_error(source: str) -> NoReturn:
    scanner = _Scanner(source)
    scanner.value()
    scanner.whitespace()
    if scanner.position < len(scanner.source):
        scanner.fail("Unexpected non-whitespace character after JSON")
    # This function is called only after the JSON decoder has rejected its input.
    scanner.unexpected()
