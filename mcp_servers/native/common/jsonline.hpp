// JSON-line protocol shared by the DAQNavi command-line bridges.
//
// One request per stdin line, a flat JSON object such as {"cmd":"read_bit","channel":3,"kind":"DI"};
// one response per stdout line: {"ok":bool,"reachable":bool,"message":string,"data":<json>}.
// Only what the bridges need is parsed: string, number, true/false/null values, no nesting.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>

#include <windows.h>

namespace hwcli {

struct Value {
    enum Kind { Null, Bool, Number, String } kind = Null;
    bool boolean = false;
    double number = 0;
    std::string text;
};

using Request = std::map<std::string, Value>;

inline void skip_space(const std::string &s, size_t &i) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) ++i;
}

inline bool parse_string(const std::string &s, size_t &i, std::string &out) {
    if (i >= s.size() || s[i] != '"') return false;
    ++i;
    while (i < s.size() && s[i] != '"') {
        char c = s[i++];
        if (c != '\\') {
            out += c;
            continue;
        }
        if (i >= s.size()) return false;
        char e = s[i++];
        switch (e) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                if (i + 4 > s.size()) return false;
                unsigned code = std::strtoul(s.substr(i, 4).c_str(), nullptr, 16);
                i += 4;
                // Encode the BMP code point as UTF-8 (surrogate pairs are not needed by any command).
                if (code < 0x80) {
                    out += static_cast<char>(code);
                } else if (code < 0x800) {
                    out += static_cast<char>(0xC0 | (code >> 6));
                    out += static_cast<char>(0x80 | (code & 0x3F));
                } else {
                    out += static_cast<char>(0xE0 | (code >> 12));
                    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
                    out += static_cast<char>(0x80 | (code & 0x3F));
                }
                break;
            }
            default: out += e; break;
        }
    }
    if (i >= s.size()) return false;
    ++i;
    return true;
}

// Parse a flat JSON object; false on anything else.
inline bool parse_request(const std::string &line, Request &out) {
    size_t i = 0;
    skip_space(line, i);
    if (i >= line.size() || line[i] != '{') return false;
    ++i;
    skip_space(line, i);
    if (i < line.size() && line[i] == '}') return true;
    while (i < line.size()) {
        std::string key;
        skip_space(line, i);
        if (!parse_string(line, i, key)) return false;
        skip_space(line, i);
        if (i >= line.size() || line[i] != ':') return false;
        ++i;
        skip_space(line, i);
        Value value;
        if (i < line.size() && line[i] == '"') {
            value.kind = Value::String;
            if (!parse_string(line, i, value.text)) return false;
        } else if (line.compare(i, 4, "true") == 0) {
            value.kind = Value::Bool;
            value.boolean = true;
            i += 4;
        } else if (line.compare(i, 5, "false") == 0) {
            value.kind = Value::Bool;
            i += 5;
        } else if (line.compare(i, 4, "null") == 0) {
            i += 4;
        } else {
            char *end = nullptr;
            value.number = std::strtod(line.c_str() + i, &end);
            if (end == line.c_str() + i) return false;
            value.kind = Value::Number;
            i = static_cast<size_t>(end - line.c_str());
        }
        out[key] = value;
        skip_space(line, i);
        if (i < line.size() && line[i] == ',') {
            ++i;
            continue;
        }
        return i < line.size() && line[i] == '}';
    }
    return false;
}

inline std::string text(const Request &r, const char *key, const std::string &fallback = "") {
    auto it = r.find(key);
    return it != r.end() && it->second.kind == Value::String ? it->second.text : fallback;
}

inline long integer(const Request &r, const char *key, long fallback = 0) {
    auto it = r.find(key);
    if (it == r.end()) return fallback;
    if (it->second.kind == Value::Number) return static_cast<long>(it->second.number);
    if (it->second.kind == Value::Bool) return it->second.boolean ? 1 : 0;
    return fallback;
}

inline bool flag(const Request &r, const char *key, bool fallback = false) {
    auto it = r.find(key);
    if (it == r.end()) return fallback;
    if (it->second.kind == Value::Bool) return it->second.boolean;
    if (it->second.kind == Value::Number) return it->second.number != 0;
    return fallback;
}

inline bool has(const Request &r, const char *key) { return r.count(key) != 0; }

inline std::string quote(const std::string &s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buffer[8];
                    std::snprintf(buffer, sizeof buffer, "\\u%04x", c);
                    out += buffer;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out + "\"";
}

inline std::string boolean(bool value) { return value ? "true" : "false"; }

inline std::string hex(unsigned value) {
    char buffer[16];
    std::snprintf(buffer, sizeof buffer, "0x%X", value);
    return buffer;
}

inline void reply(bool ok, bool reachable, const std::string &message, const std::string &data = "null") {
    std::string line = "{\"ok\":" + boolean(ok) + ",\"reachable\":" + boolean(reachable) +
                       ",\"message\":" + quote(message) + ",\"data\":" + data + "}\n";
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
}

inline void ok(const std::string &message, const std::string &data) { reply(true, true, message, data); }
inline void fail(const std::string &message, bool reachable = true) { reply(false, reachable, message); }

inline std::wstring wide(const std::string &utf8) {
    if (utf8.empty()) return std::wstring();
    int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring out(static_cast<size_t>(size > 0 ? size - 1 : 0), L'\0');
    if (size > 1) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &out[0], size);
    return out;
}

inline std::string narrow(const wchar_t *text) {
    int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(size > 0 ? size - 1 : 0), '\0');
    if (size > 1) WideCharToMultiByte(CP_UTF8, 0, text, -1, &out[0], size, nullptr, nullptr);
    return out;
}

// Read stdin lines until EOF and hand each parsed request to ``handle``.
template <typename Handler>
int serve(Handler handle) {
    std::string line;
    int c;
    while ((c = std::fgetc(stdin)) != EOF) {
        if (c != '\n') {
            line += static_cast<char>(c);
            continue;
        }
        Request request;
        if (!parse_request(line, request)) {
            fail("Malformed request line", false);
        } else {
            handle(request);
        }
        line.clear();
    }
    return 0;
}

}  // namespace hwcli
