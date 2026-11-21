import io
import json
from types import SimpleNamespace

import pytest

import youtube_live
from youtube_live import YouTubeLiveError, clip_candidates


VIDEO_ID = "Ab1_cd-Ef02"
REPLAY = {
    "protocol": "youtube_live_chat_replay",
    "video_id": VIDEO_ID,
    "url": f"https://www.youtube.com/watch?v={VIDEO_ID}&has_verified=1",
}


def _item(renderer, author=None):
    message = {"message": {"runs": [{"text": "chat text"}]}}
    if author is not None:
        message["authorExternalChannelId"] = author
    return {"addChatItemAction": {"item": {renderer: message}}}


def _replay(offset, *actions):
    return {"replayChatItemAction": {"videoOffsetTimeMsec": offset, "actions": actions}}


def test_chat_parser_counts_viewer_messages_not_chat_controls():
    line = json.dumps(_replay(
        "15750",
        _item("liveChatTextMessageRenderer", "text-author"),
        _item("liveChatPaidMessageRenderer", "paid-author"),
        _item("liveChatPaidStickerRenderer", "sticker-author"),
        _item("liveChatTextMessageRenderer"),
        _item("liveChatMembershipItemRenderer", "member"),
        _item("liveChatViewerEngagementMessageRenderer", "service"),
        {"addBannerToLiveChatCommand": _item("liveChatTextMessageRenderer", "banner")},
        {"removeChatItemAction": {"targetItemId": "deleted"}},
        None,
    ))
    assert list(youtube_live._message_events(line)) == [
        (15.75, "text-author"), (15.75, "paid-author"), (15.75, "sticker-author"),
    ]


@pytest.mark.parametrize("line", [
    "not json", "{}", "[]", '{"replayChatItemAction": null}',
    json.dumps(_replay("invalid", _item("liveChatTextMessageRenderer", "author"))),
    json.dumps(_replay("-1", _item("liveChatTextMessageRenderer", "author"))),
])
def test_chat_parser_ignores_rows_without_valid_replay_offsets(line):
    assert list(youtube_live._message_events(line)) == []


def test_diverse_chat_outranks_spam_with_reaction_lead_and_no_overlap():
    spam = [(16 + i / 10, "spammer") for i in range(100)]
    diverse = [(70 + i, f"viewer-{i}") for i in range(5)]
    tied_or_overlapping = [(73.5, "viewer-1"), (76, "viewer-2")]
    clips = clip_candidates(
        reversed(spam + diverse + tied_or_overlapping), source_start=0, duration=120,
        clip_seconds=20, limit=10,
    )
    assert clips == [
        {"start": 60.0, "end": 80.0, "viewers": 5},
        {"start": 6.0, "end": 26.0, "viewers": 1},
    ]


def test_truncated_source_bounds_and_exclusive_end():
    events = [
        (99.999, "before"), (100, "first"), (100.5, "next"),
        (129.999, "last"), (130, "outside-end"), (140, "outside"),
    ]
    assert clip_candidates(events, source_start=100, duration=30, clip_seconds=8, limit=2) == [
        {"start": 0.0, "end": 8.0, "viewers": 2},
        {"start": 22.0, "end": 30.0, "viewers": 1},
    ]
    assert clip_candidates([(104, "viewer")], source_start=100, duration=7, clip_seconds=20, limit=3) == [
        {"start": 0.0, "end": 7.0, "viewers": 1},
    ]
    assert clip_candidates([(130, "outside")], source_start=100, duration=30, clip_seconds=8, limit=2) == []


def test_reaction_messages_fit_inside_short_clips():
    clips = clip_candidates(
        [(40, "a"), (41.99, "b")], source_start=0, duration=60, clip_seconds=4, limit=1,
    )
    assert clips == [{"start": 38.0, "end": 42.0, "viewers": 2}]


def test_ten_second_windows_overlap_and_the_late_peak_beats_the_opening():
    events = [(20, "a"), (22, "b"), (25, "c")]
    # One burst crosses a 10-second boundary; the first and last messages
    # are 12 seconds apart and must not be scored together.
    events += [(6606, "d"), (6608, "e"), (6610, "f"), (6612, "g"), (6618, "h")]
    assert clip_candidates(events, source_start=0, duration=7200, clip_seconds=30, limit=1) == [
        {"start": 6596.0, "end": 6626.0, "viewers": 4},
    ]


def _storyboard(width=160, height=90, *, host="i.ytimg.com"):
    return {"protocol": "mhtml", "width": width, "height": height,
            "fps": 0.1, "rows": 2, "columns": 2, "fragments": [
                {"url": f"https://{host}/sb/{VIDEO_ID}/storyboard/L2/M{n}.jpg"} for n in range(3)
            ]}


@pytest.mark.parametrize("at,page,box,sample", [
    (0, 0, (0, 0, 160, 90), 0),
    (39.9, 0, (160, 90, 320, 180), 30),
    (40, 1, (0, 0, 160, 90), 40),
    (60, 1, (0, 90, 160, 180), 60),
    (90, 2, (0, 0, 160, 90), 80),
])
def test_storyboard_tiles_are_row_major_and_last_sheet_is_partial(at, page, box, sample):
    best = _storyboard()
    assert youtube_live._storyboard_tile(
        [_storyboard(80, 45), _storyboard(320, 180, host="example.com"), _storyboard(180, 320), best],
        VIDEO_ID, 90, at,
    ) == (best["fragments"][page]["url"], box, sample)


def test_missing_storyboard_does_not_fall_back_to_upload_poster():
    with pytest.raises(YouTubeLiveError, match="no landscape preview"):
        youtube_live._storyboard_tile(
            [{"url": f"https://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg"}], VIDEO_ID, 90, 30)


@pytest.mark.parametrize("status,tracks,code", [
    ("is_live", [REPLAY], 422),
    ("is_upcoming", [REPLAY], 422),
    ("post_live", [REPLAY], 409),
    ("not_live", [REPLAY], 422),
    ("was_live", [], 422),
    ("was_live", [{**REPLAY, "protocol": "youtube_live_chat"}], 422),
])
def test_only_completed_streams_with_replay_track_are_eligible(status, tracks, code):
    info = {"id": VIDEO_ID, "duration": 90, "live_status": status, "subtitles": {"live_chat": tracks}}
    with pytest.raises(YouTubeLiveError) as error:
        youtube_live._completed_replay(info, VIDEO_ID)
    assert error.value.status_code == code
    assert youtube_live._completed_replay({**info, "live_status": "was_live", "subtitles": {
        "live_chat": [REPLAY],
    }}, VIDEO_ID) == (90.0, REPLAY)


def test_only_direct_and_static_routes(monkeypatch):
    monkeypatch.setenv("STATIC_PROXY_URLS", " http://static.example , ,http://paid.example")
    monkeypatch.setenv("PROXY_URL", "http://paid.example")
    assert list(youtube_live._routes()) == ["", "http://static.example"]
    with pytest.raises(YouTubeLiveError) as error:
        youtube_live.fetch_chat(f"{VIDEO_ID}&other=abc")
    assert error.value.status_code == 400


def test_preview_rejects_requests_when_both_slots_are_busy():
    slots = youtube_live._PREVIEW_SLOTS
    with slots, slots:
        with pytest.raises(YouTubeLiveError) as error:
            youtube_live.preview(VIDEO_ID)
    assert error.value.status_code == 429


@pytest.mark.parametrize("case", [
    "complete", "selected_range", "slow_complete", "deadline", "event_limit",
    "long_complete", "long_early_range", "long_request_limit",
])
def test_fetch_chat_uses_only_verified_replay_protocol(monkeypatch, case):
    yt_dlp = pytest.importorskip("yt_dlp")
    from yt_dlp.extractor.youtube import YoutubeBaseInfoExtractor

    calls = []
    clock = [0]
    monkeypatch.setattr(youtube_live, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    if case == "event_limit":
        monkeypatch.setattr(youtube_live, "_CHAT_MAX_EVENTS", 1)
    long_replay = case.startswith("long_")
    watch = {"contents": {"twoColumnWatchNextResults": {"conversationBar": {
        "liveChatRenderer": {"continuations": [{"reloadContinuationData": {"continuation": "first"}}]},
    }}}}
    config = {"INNERTUBE_API_KEY": "unused", "INNERTUBE_CONTEXT": {"client": {}}}

    def page(author, seconds, continuation=None):
        data = {"actions": [_replay(str(seconds * 1000), _item("liveChatTextMessageRenderer", author))]}
        if continuation:
            data["continuations"] = [{"liveChatReplayContinuationData": {"continuation": continuation}}]
        return {"continuationContents": {"liveChatContinuation": data}}

    def mock_info(_self, _url, *, download, process, ie_key):
        assert not download and not process and ie_key == "Youtube"
        duration = 86_400 if case == "long_request_limit" else 13_944 if long_replay else 90
        return {"id": VIDEO_ID, "duration": duration, "live_status": "was_live",
                "subtitles": {"live_chat": [{**REPLAY, "protocol": "youtube_live_chat"}, REPLAY]}}

    def mock_request(self, request):
        assert youtube_live.ssrf_guard.active()
        assert self.params["proxy"] == "" and not self.params.get("cookiefile")
        calls.append(request.url)
        if long_replay and len(calls) > 1:
            number = len(calls) - 1
            seconds = number // 2 if case == "long_early_range" else number * 3
            end_page = 16_010 if case == "long_request_limit" else 4_050
            response = page("viewer", seconds, "next" if number < end_page else None)
            return io.BytesIO(json.dumps(response).encode())
        responses = [watch, page("viewer-1", 1, "next"), page("viewer-2", 40, "unused-next"),
                     page("viewer-3", 42)]
        return io.BytesIO(json.dumps(responses[len(calls) - 1]).encode())

    def parse_page(_self, _id, body):
        if len(calls) == 2:
            if case == "deadline":
                clock[0] = 1800
            elif case == "slow_complete":
                clock[0] = 121
        if case == "long_complete" and len(calls) == 4000:
            clock[0] = 1801
        return json.loads(body)

    monkeypatch.setattr(yt_dlp.YoutubeDL, "extract_info", mock_info)
    monkeypatch.setattr(yt_dlp.YoutubeDL, "urlopen", mock_request)
    monkeypatch.setattr(YoutubeBaseInfoExtractor, "extract_yt_initial_data", parse_page)
    monkeypatch.setattr(YoutubeBaseInfoExtractor, "extract_ytcfg", lambda _self, _id, _body: config)
    continuation_url = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key=unused"
    assert_calls = [REPLAY["url"], "https://www.youtube.com/live_chat_replay?continuation=first"]
    if case == "deadline":
        with pytest.raises(YouTubeLiveError, match=r"\(time\).*No clips were selected") as error:
            youtube_live.fetch_chat(VIDEO_ID)
        assert error.value.status_code == 503
    elif case == "selected_range":
        assert youtube_live.fetch_chat(VIDEO_ID, source_end=40) == [(1.0, "viewer-1")]
        assert_calls.append(continuation_url)
    elif case == "event_limit":
        with pytest.raises(YouTubeLiveError, match="too much live chat") as error:
            youtube_live.fetch_chat(VIDEO_ID)
        assert error.value.status_code == 422
        assert_calls.append(continuation_url)
    elif case == "long_complete":
        events = youtube_live.fetch_chat(VIDEO_ID, source_start=12_000)
        assert events[0] == (12_000, "viewer")
        assert events[-1] == (12_150, "viewer")
        assert len(events) == 51
        return
    elif long_replay:
        source_end = 3600 if case == "long_early_range" else float("inf")
        with pytest.raises(YouTubeLiveError, match=r"\(request count\).*No clips were selected"):
            youtube_live.fetch_chat(VIDEO_ID, source_end=source_end)
        assert len(calls) == (4_000 if case == "long_early_range" else 16_000)
        return
    else:
        assert youtube_live.fetch_chat(VIDEO_ID, source_start=30) == [(40.0, "viewer-2"), (42.0, "viewer-3")]
        assert_calls.extend([continuation_url, continuation_url])
    assert calls == assert_calls
