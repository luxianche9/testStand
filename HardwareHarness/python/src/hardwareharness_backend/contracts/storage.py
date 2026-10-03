from typing import Any

from hardwareharness_backend.contracts.validation import (
    array,
    boolean,
    enum,
    literal,
    obj,
    parse_record,
    string,
)
from hardwareharness_backend.util import Record

theme_choice_schema = enum("system", "light", "dark")
welcome_layout_schema = enum("grid", "list")
project_view_schema = enum("wiring", "plans", "runs", "manual").catch("wiring")
user_settings_schema = obj(
    {
        "formatVersion": literal(1).default(1),
        "theme": theme_choice_schema.default("system"),
        "recentProjects": array(
            obj({"rootPath": string(1), "name": string(1), "openedAt": string(datetime=True)})
        ).default([]),
        "welcomeLayout": welcome_layout_schema.default("grid"),
        "projectView": project_view_schema.default("wiring"),
        "llm": obj(
            {
                "baseUrl": string(url=True).default("https://api.openai.com/v1"),
                "model": string(1, trim=True).default("gpt-4.1"),
            }
        ).default({"baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1"}),
    }
)
llm_settings_input_schema = obj(
    {
        "baseUrl": string(trim=True, url=True),
        "model": string(1, trim=True),
        "apiKey": string().optional(),
        "clearApiKey": boolean().optional(),
    }
)


def parse_user_settings(value: Any) -> Record:
    return parse_record(user_settings_schema, value)


def parse_llm_settings_input(value: Any) -> Record:
    return parse_record(llm_settings_input_schema, value)
