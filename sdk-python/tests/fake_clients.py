"""Clients shaped like the real ``openai`` and ``anthropic`` ones: SDK-object responses, ``stream=True`` streams, the
``.stream()`` context-manager helpers, sync and async. Shared by the framework adapter tests."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any


USAGE = {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 20}}


def ns(value: Any) -> Any:
    """Dicts into attribute objects, the way the SDKs hand back pydantic models."""
    if isinstance(value, dict):
        return SimpleNamespace(**{k: ns(v) for k, v in value.items()})
    if isinstance(value, list):
        return [ns(v) for v in value]
    return value


def chat_completion(content: str, finish: str = "stop") -> Any:
    return ns({"id": "chatcmpl_1", "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}], "usage": USAGE})


def chat_chunks(content: str, finish: str = "stop") -> list:
    words = content.split(" ")
    return ns(
        [{"id": "c", "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}]
        + [{"id": "c", "choices": [{"index": 0, "delta": {"content": (" " if i else "") + w}, "finish_reason": None}]} for i, w in enumerate(words)]
        + [{"id": "c", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"id": "c", "choices": [], "usage": USAGE}]
    )


class FakeStream:
    """An ``openai.Stream`` / ``anthropic.Stream``: an iterator with ``response`` and a context manager."""

    def __init__(self, chunks: list):
        self._chunks = iter(chunks)
        self.response = SimpleNamespace(status_code=200)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        self.closed = True


class FakeAsyncStream:
    def __init__(self, chunks: list):
        self._chunks = iter(chunks)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._chunks)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeChatStreamManager:
    """``client.chat.completions.stream(...)``: a context manager whose stream keeps a ``current_completion_snapshot``."""

    def __init__(self, content: str):
        self._content = content

    def __enter__(self):
        chunks = chat_chunks(self._content)
        stream = FakeStream(chunks)
        stream.current_completion_snapshot = None  # type: ignore[attr-defined]

        def get_final_completion():
            for _ in stream:
                pass
            return chat_completion(self._content, "length")

        stream.get_final_completion = get_final_completion  # type: ignore[attr-defined]
        return stream

    def __exit__(self, *exc):
        return None


class FakeOpenAI:
    """Private state reached only through the real receiver, a nested resource tree, and unrelated members."""

    def __init__(self):
        self.__calls = 0
        self.calls: list = []
        self.fail: Any = None
        self.timeout = 30
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._chat_create, stream=self._chat_stream))
        self.responses = SimpleNamespace(create=self._responses_create)
        self.models = SimpleNamespace(list=lambda: ["gpt-5"])

    def count(self) -> int:
        return self.__calls

    def _chat_create(self, **params):
        self.__calls += 1
        self.calls.append(params)
        if self.fail is not None:
            raise self.fail
        content = f"answer {self.__calls} refund guaranteed"
        if params.get("stream"):
            return FakeStream(chat_chunks("streamed " + content, "length"))
        return chat_completion(content)

    def _chat_stream(self, **params):
        self.calls.append(params)
        return FakeChatStreamManager("helper answer")

    def _responses_create(self, **params):
        self.calls.append(params)
        response = {
            "id": "resp_1",
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "responses answer"}]}],
            "usage": {"input_tokens": 50, "output_tokens": 10, "input_tokens_details": {"cached_tokens": 5}},
        }
        if params.get("stream"):
            return FakeStream(ns([
                {"type": "response.created", "response": {"id": "resp_1"}},
                {"type": "response.output_text.delta", "delta": "responses "},
                {"type": "response.output_text.delta", "delta": "answer"},
                {"type": "response.incomplete", "response": response},
            ]))
        return ns({**response, "output_text": "responses answer"})


def anthropic_message(text: str, stop: str = "end_turn") -> Any:
    return ns({"id": "msg_1", "type": "message", "role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": stop, "usage": {"input_tokens": 40, "output_tokens": 12, "cache_read_input_tokens": 8}})


def anthropic_events(text: str, stop: str = "end_turn") -> list:
    words = text.split(" ")
    return ns(
        [{"type": "message_start", "message": {"id": "msg_2", "role": "assistant", "content": [], "usage": {"input_tokens": 40, "output_tokens": 1, "cache_read_input_tokens": 8}}}, {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}]
        + [{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": (" " if i else "") + w}} for i, w in enumerate(words)]
        + [{"type": "content_block_stop", "index": 0}, {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 12}}, {"type": "message_stop"}]
    )


class FakeMessageStreamManager:
    """``client.messages.stream(...)``: the stream has ``text_stream``, ``get_final_message`` and a snapshot."""

    def __init__(self, text: str, stop: str = "end_turn"):
        self._text, self._stop = text, stop

    def __enter__(self):
        stream = FakeStream(anthropic_events(self._text, self._stop))
        stream.current_message_snapshot = anthropic_message(self._text, self._stop)  # type: ignore[attr-defined]
        stream.get_final_message = lambda: anthropic_message(self._text, self._stop)  # type: ignore[attr-defined]
        stream.text_stream = iter(self._text.split(" "))  # type: ignore[attr-defined]
        return stream

    def __exit__(self, *exc):
        return None


class FakeAnthropic:
    def __init__(self):
        self.calls: list = []
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    def _create(self, **params):
        self.calls.append(params)
        if params.get("stream"):
            return FakeStream(anthropic_events("streamed reply", "max_tokens"))
        return anthropic_message("plain reply")

    def _stream(self, **params):
        self.calls.append(params)
        return FakeMessageStreamManager("helper reply", "max_tokens")


class FakeAsyncAnthropic:
    def __init__(self):
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    async def _create(self, **params):
        await asyncio.sleep(0)
        if params.get("stream"):
            return FakeAsyncStream(anthropic_events("async streamed", "max_tokens"))
        return anthropic_message("async plain")

    def _stream(self, **params):
        manager = FakeMessageStreamManager("async helper")

        class AsyncManager:
            async def __aenter__(self):
                return manager.__enter__()

            async def __aexit__(self, *exc):
                return None

        return AsyncManager()




class FakeAsyncOpenAI:
    """``AsyncOpenAI``: ``create`` is a coroutine function, as the real one is (seen through its decorators)."""

    def __init__(self):
        self.calls: list = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._chat_create))

    async def _chat_create(self, **params):
        await asyncio.sleep(0)
        self.calls.append(params)
        if params.get("stream"):
            return FakeAsyncStream(chat_chunks("async streamed answer", "length"))
        return chat_completion("async answer")
