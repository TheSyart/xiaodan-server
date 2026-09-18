"""xiaodan_bridge_core(设备桥纯逻辑)的单元测试。只用标准库:

    python3 -m unittest discover -s server/tests -v

真实引擎里的端到端(chat() 走 provider、桥接口、主动播报)见 server/tests/smoke_agent.py。
"""

import os
import queue
import sys
import threading
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

import xiaodan_bridge_core as core  # noqa: E402


def conn(session_id="s1", device_id="4C:11:AE:31:7A:30", **extra):
    base = dict(session_id=session_id, device_id=device_id, verified=True)
    base.update(extra)
    return SimpleNamespace(**base)


class MacTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(core.normalize_mac("4C:11:AE:31:7A:30"), "4c:11:ae:31:7a:30")
        self.assertEqual(core.normalize_mac("4c-11-ae-31-7a-30"), "4c:11:ae:31:7a:30")
        self.assertEqual(core.normalize_mac("4c11ae317a30"), "4c:11:ae:31:7a:30")
        self.assertIsNone(core.normalize_mac("4c:11:ae:31:7a"))
        self.assertIsNone(core.normalize_mac(None))


class RegistryTest(unittest.TestCase):
    def test_lookup_by_session_and_mac(self):
        registry = core.Registry(is_verified=lambda c: c.verified)
        a = conn()
        registry.add(a)
        self.assertIs(registry.by_session("s1"), a)
        self.assertIs(registry.by_mac("4c-11-ae-31-7a-30"), a)
        self.assertEqual(len(registry), 1)

    def test_unverified_connection_not_found_by_mac(self):
        registry = core.Registry(is_verified=lambda c: c.verified)
        registry.add(conn(verified=False))
        self.assertIsNone(registry.by_mac("4c:11:ae:31:7a:30"))
        self.assertIsNotNone(registry.by_session("s1"), "按会话查不受影响:provider 要找到自己的连接")

    def test_late_close_of_old_connection_keeps_new_index(self):
        registry = core.Registry()
        old, new = conn("old"), conn("new")
        registry.add(old)
        registry.add(new)
        registry.remove(old)
        self.assertIs(registry.by_mac("4c:11:ae:31:7a:30"), new)
        self.assertIsNone(registry.by_session("old"))
        registry.remove(old)  # 幂等
        registry.remove(new)
        self.assertIsNone(registry.by_mac("4c:11:ae:31:7a:30"))

    def test_verifier_exception_means_not_found(self):
        registry = core.Registry(is_verified=lambda c: 1 / 0)
        registry.add(conn())
        self.assertIsNone(registry.by_mac("4c:11:ae:31:7a:30"))

    def test_thread_safety(self):
        registry = core.Registry()

        def churn(prefix):
            for i in range(300):
                c = conn(f"{prefix}{i}")
                registry.add(c)
                registry.by_mac("4c:11:ae:31:7a:30")
                registry.remove(c)

        threads = [threading.Thread(target=churn, args=(p,)) for p in "abcd"]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(registry), 0)


class BusyTest(unittest.TestCase):
    def idle(self, **extra):
        tts = SimpleNamespace(tts_text_queue=queue.Queue(), tts_audio_queue=queue.Queue())
        base = dict(tts=tts, asr_audio=[], client_is_speaking=False, last_activity_time=time.time() * 1000)
        base.update(extra)
        return SimpleNamespace(**base)

    def test_idle(self):
        self.assertEqual(core.busy_reason(self.idle()), "")

    def test_reasons(self):
        self.assertEqual(core.busy_reason(self.idle(_xd_turn_active=True)), "turn")
        self.assertEqual(core.busy_reason(self.idle(_xd_asr_busy=True)), "recognizing")
        # 手动拾音:listen stop 之后才到的几帧会留在 asr_audio 里,不能当成还在听
        self.assertEqual(core.busy_reason(self.idle(asr_audio=[b"x"])), "")
        now = time.monotonic()
        self.assertEqual(core.busy_reason(self.idle(_xd_last_audio_in=now - 0.5), now=now), "listening")
        self.assertEqual(core.busy_reason(self.idle(_xd_last_audio_in=now - 5), now=now), "")
        c = self.idle()
        c.tts.tts_audio_queue.put(1)
        self.assertEqual(core.busy_reason(c), "speaking")
        c = self.idle(audio_rate_controller=SimpleNamespace(queue=[1, 2]))
        self.assertEqual(core.busy_reason(c), "speaking")
        self.assertEqual(core.busy_reason(self.idle(client_is_speaking=True)), "speaking")

    def test_stale_speaking_flag(self):
        stale = self.idle(client_is_speaking=True, last_activity_time=time.time() * 1000 - 60_000)
        self.assertEqual(core.busy_reason(stale), "")

    def test_not_ready(self):
        ready = SimpleNamespace(stop_event=threading.Event(), need_bind=False, bind_completed_event=threading.Event(),
                                tts=object(), websocket=object())
        ready.bind_completed_event.set()
        self.assertEqual(core.not_ready_reason(ready), "")
        ready.need_bind = True
        self.assertEqual(core.not_ready_reason(ready), "unbound")
        ready.need_bind = False
        ready.stop_event.set()
        self.assertEqual(core.not_ready_reason(ready), "closing")


class SseTest(unittest.TestCase):
    def test_events_heartbeats_and_multiline(self):
        parser = core.SseParser()
        events = []
        for line in [': hb', '', 'data: {"t":"text",', 'data: "v":"你好"}', '', b'data: {"t":"done"}\r\n', b'\r\n', 'data: nope', '']:
            events.extend(parser.feed_line(line))
        self.assertEqual(events[0], {"t": "hb"})
        self.assertEqual(events[1], {"t": "text", "v": "你好"})
        self.assertEqual(events[2], {"t": "done"})
        self.assertEqual(events[3]["t"], "invalid")

    def test_finish_flushes(self):
        parser = core.SseParser()
        parser.feed_line('data: {"t":"done"}')
        self.assertEqual(parser.finish(), [{"t": "done"}])
        self.assertEqual(parser.finish(), [])


class MiscTest(unittest.TestCase):
    def test_same_origin(self):
        base = "http://console:8002/xiaodan/agent/turn"
        self.assertTrue(core.same_origin(base, "http://console:8002/xiaodan/media/1/audio"))
        self.assertFalse(core.same_origin(base, "http://169.254.169.254/latest"))
        self.assertFalse(core.same_origin(base, "https://console:8002/x"))
        self.assertFalse(core.same_origin(base, "http://console:9000/x"))

    def test_media_extension(self):
        self.assertEqual(core.media_extension(".OGG"), "ogg")
        self.assertIsNone(core.media_extension("exe"))

    def test_device_message_limits(self):
        self.assertEqual(core.clamp_device_message({"type": "xiaodan", "cmd": "volume"}, "s"),
                         '{"type":"xiaodan","cmd":"volume","session_id":"s"}')
        self.assertIsNone(core.clamp_device_message({"cmd": "x"}, "s"))
        self.assertIsNone(core.clamp_device_message({"type": "x", "d": "字" * 2000}, "s"))



class LevelTest(unittest.TestCase):
    def test_xiaodan_level(self):
        self.assertEqual(core.xiaodan_level({"xiaodan": 3}), 3)
        self.assertEqual(core.xiaodan_level({"xiaodan": True}), 1)
        self.assertEqual(core.xiaodan_level({"xiaodan": False}), 0)
        self.assertEqual(core.xiaodan_level({"xiaodan": "3"}), 0)
        self.assertEqual(core.xiaodan_level(None), 0)


class CuesTest(unittest.TestCase):
    def test_valid_cues_are_normalized(self):
        self.assertEqual(core.validate_cues([{"ms": 0, "x": "从前", "p": 1}, {"ms": 0, "x": "有座山"}]),
                         [{"ms": 0, "x": "从前", "p": True}, {"ms": 0, "x": "有座山", "p": False}])

    def test_invalid_cues_are_rejected_as_a_whole(self):
        for bad in (
            [], "x", [{"ms": 5, "x": "a"}, {"ms": 1, "x": "b"}], [{"ms": -1, "x": "a"}], [{"ms": 1.5, "x": "a"}],
            [{"ms": True, "x": "a"}], [{"ms": 0, "x": ""}], [{"ms": 0, "x": "字" * 51}], [{"ms": 0, "x": "a\x1eb"}],
            [{"ms": 0, "x": "a\nb"}], [{"ms": i, "x": "a"} for i in range(core.CUE_MAX_COUNT + 1)],
        ):
            self.assertIsNone(core.validate_cues(bad), bad if len(str(bad)) < 80 else "too many")


class DeckStoreTest(unittest.TestCase):
    MAC = "4C:11:AE:31:7A:30"

    def test_put_get_drop(self):
        store = core.DeckStore()
        self.assertTrue(store.put(self.MAC, 7, 1, 3, " apple。苹果。 "))
        self.assertEqual(store.get("4c:11:ae:31:7a:30", 7, 1), "apple。苹果。")
        self.assertIsNone(store.get(self.MAC, 7, 0))
        self.assertIsNone(store.get(self.MAC, 7, 3))
        self.assertIsNone(store.get(self.MAC, 8, 1))
        store.drop(self.MAC, 7)
        self.assertIsNone(store.get(self.MAC, 7, 1))

    def test_rejects_bad_input(self):
        store = core.DeckStore()
        for args in ((self.MAC, 0, 0, 3, "a"), (self.MAC, 7, 3, 3, "a"), (self.MAC, 7, 0, 11, "a"),
                     ("nope", 7, 0, 3, "a"), (self.MAC, 7, 0, 3, "  "), (self.MAC, 7, 0, 3, None), (self.MAC, "7", 0, 3, "a")):
            self.assertFalse(store.put(*args), args)
        self.assertEqual(len(store), 0)

    def test_new_count_replaces_deck_and_ttl_expires(self):
        now = [0.0]
        store = core.DeckStore(ttl_s=10, clock=lambda: now[0])
        store.put(self.MAC, 7, 0, 3, "a")
        store.put(self.MAC, 7, 0, 2, "b")
        self.assertEqual(store.get(self.MAC, 7, 0), "b")
        now[0] = 11
        self.assertIsNone(store.get(self.MAC, 7, 0))

    def test_drop_all_and_capacity(self):
        store = core.DeckStore(max_decks=2)
        for deck_id in (1, 2, 3):
            store.put(self.MAC, deck_id, 0, 1, "w")
        self.assertEqual(len(store), 2)
        store.drop(self.MAC)
        self.assertEqual(len(store), 0)

    def test_exit_notes(self):
        now = [0.0]
        store = core.DeckStore(ttl_s=10, clock=lambda: now[0])
        self.assertIsNone(store.pop_exit(self.MAC))
        store.note_exit("4c-11-ae-31-7a-30", 7, "user")
        self.assertEqual(store.pop_exit(self.MAC), {"id": 7, "why": "user"})
        self.assertIsNone(store.pop_exit(self.MAC), "取走一次就没了")
        store.note_exit(self.MAC, "x", 5)
        self.assertEqual(store.pop_exit(self.MAC), {"id": 0, "why": ""})
        store.note_exit(self.MAC, 7, "idle")
        now[0] = 11
        self.assertIsNone(store.pop_exit(self.MAC), "过期不报")
        store.note_exit("nope", 7, "user")
        self.assertIsNone(store.pop_exit("nope"))


class DeviceCommandTest(unittest.TestCase):
    def test_accepted_commands(self):
        self.assertEqual(core.parse_device_command({"type": "xiaodan", "cmd": "deck_say", "id": 7, "i": 2}), {"cmd": "deck_say", "id": 7, "i": 2})
        self.assertEqual(core.parse_device_command({"type": "xiaodan", "cmd": "deck_at", "id": 7, "i": 0})["cmd"], "deck_at")
        self.assertEqual(core.parse_device_command({"type": "xiaodan", "cmd": "deck_exit", "id": 0, "why": "nomem"}),
                         {"cmd": "deck_exit", "id": 0, "why": "nomem"})
        self.assertEqual(core.parse_device_command({"type": "xiaodan", "cmd": "img", "id": 3, "ok": True, "w": 96}),
                         {"cmd": "img", "id": 3, "ok": True, "w": 96})

    def test_rejected_commands(self):
        for bad in (
            None, {"type": "tts"}, {"type": "xiaodan", "cmd": "say", "text": "hi"},
            {"type": "xiaodan", "cmd": "deck_say", "id": 0, "i": 0}, {"type": "xiaodan", "cmd": "deck_say", "id": 7, "i": 10},
            {"type": "xiaodan", "cmd": "deck_say", "id": True, "i": 0}, {"type": "xiaodan", "cmd": "img", "id": 1, "ok": 1},
            {"type": "xiaodan", "cmd": "img", "id": 1, "ok": True, "w": 200},
        ):
            self.assertIsNone(core.parse_device_command(bad), bad)

    def test_rate_limit(self):
        now = [0.0]
        limit = core.RateLimit(0.6, clock=lambda: now[0])
        self.assertTrue(limit.allow("a"))
        self.assertFalse(limit.allow("a"))
        self.assertTrue(limit.allow("b"))
        now[0] = 0.61
        self.assertTrue(limit.allow("a"))

    def test_long_interval_rate_limit_is_not_pruned_early(self):
        # 间隔 300 秒的限流器,键多于 256 个时不能被「清掉 60 秒前的项」误清成形同虚设
        now = [0.0]
        limit = core.RateLimit(300, clock=lambda: now[0])
        self.assertTrue(limit.allow("watched"))
        now[0] = 100.0
        for i in range(300):
            limit.allow(f"other-{i}")
        self.assertFalse(limit.allow("watched"), "间隔没到就不该放行")
        now[0] = 301.0
        self.assertTrue(limit.allow("watched"))


class LocationCommandTest(unittest.TestCase):
    def test_parses_access_points(self):
        command = core.parse_device_command({
            "type": "xiaodan", "cmd": "loc",
            "self": "001122334455,-46",
            "aps": ["001122334455,-46", "00:11:22:33:44:66,-70", "zzz,-40", "001122334477,5"],
        })
        self.assertEqual(command["cmd"], "loc")
        self.assertEqual(command["self"], {"bssid": "001122334455", "rssi": -46})
        self.assertEqual([bss["bssid"] for bss in command["aps"]], ["001122334455", "001122334466"])

    def test_rejects_empty_or_bad(self):
        for bad in (
            {"type": "xiaodan", "cmd": "loc"},
            {"type": "xiaodan", "cmd": "loc", "aps": []},
            {"type": "xiaodan", "cmd": "loc", "aps": ["001122334455"]},
            {"type": "xiaodan", "cmd": "loc", "aps": ["00112233445,-40"]},
            {"type": "xiaodan", "cmd": "loc", "aps": ["001122334455,-200"]},
        ):
            self.assertIsNone(core.parse_device_command(bad), bad)

    def test_caps_the_number_of_access_points(self):
        aps = [f"0011223344{i:02x},-50" for i in range(40)]
        command = core.parse_device_command({"type": "xiaodan", "cmd": "loc", "aps": aps})
        self.assertEqual(len(command["aps"]), core.MAX_LOC_APS)

    def test_bssid_is_masked_in_logs(self):
        self.assertEqual(core.mask_bssid("001122334455"), "0011**")
        self.assertEqual(core.mask_bssid(""), "**")


if __name__ == "__main__":
    unittest.main()
