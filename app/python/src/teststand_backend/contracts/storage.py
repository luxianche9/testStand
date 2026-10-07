from typing import Any

from teststand_backend.contracts.validation import (
    array,
    boolean,
    enum,
    literal,
    obj,
    parse_record,
    string,
)
from teststand_backend.util import Record

theme_choice_schema = enum("system", "light", "dark")
welcome_layout_schema = enum("grid", "list")
# 运行监控 was merged into the bench's signal view; a stored "runs" falls back to the bench.
project_view_schema = enum("bench", "plans").catch("bench")
# How OpenCode talks to the endpoint: OpenAI-compatible Chat Completions (DeepSeek, Qwen, Kimi,
# GLM, most gateways) or the OpenAI Responses API (OpenAI, and gateways whose Chat Completions
# path garbles tool arguments).
llm_api_schema = enum("chat", "responses")
user_settings_schema = obj(
    {
        "formatVersion": literal(1).default(1),
        "theme": theme_choice_schema.default("system"),
        "recentProjects": array(
            obj({"rootPath": string(1), "name": string(1), "openedAt": string(datetime=True)})
        ).default([]),
        "welcomeLayout": welcome_layout_schema.default("grid"),
        "projectView": project_view_schema.default("bench"),
        "llm": obj(
            {
                "baseUrl": string(url=True).default("https://api.openai.com/v1"),
                "model": string(1, trim=True).default("gpt-4.1"),
                "api": llm_api_schema.default("chat"),
            }
        ).default({"baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1", "api": "chat"}),
    }
)
llm_settings_input_schema = obj(
    {
        "baseUrl": string(trim=True, url=True),
        "model": string(1, trim=True),
        "api": llm_api_schema.default("chat"),
        "apiKey": string().optional(),
        "clearApiKey": boolean().optional(),
    }
)


def parse_user_settings(value: Any) -> Record:
    return parse_record(user_settings_schema, value)


def parse_llm_settings_input(value: Any) -> Record:
    return parse_record(llm_settings_input_schema, value)
