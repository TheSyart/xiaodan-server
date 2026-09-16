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
        self.assertEqual(core.busy_reason(self.idle(asr_audio=[b"x"])), "listening")
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


if __name__ == "__main__":
    unittest.main()
