"""
When the UART buffer lets go of what it has (issue #260 verification).

MicroPython's raw REPL answers every statement with `OK` <EOT> traceback <EOT>
`>` and not a single newline. The buffer used to flush only on newline,
carriage return, a period or 256 bytes, so that answer sat in it — and the
project uploader, which waits for the board's end-of-execution marker before
sending the next step, timed out with the board idle at the prompt.
"""
import unittest

from app.services.esp32_lib_manager import _UartBuffer


def feed_all(buf: _UartBuffer, text: bytes) -> str:
    """Everything the buffer released while consuming `text`."""
    return ''.join(out for b in text if (out := buf.feed(b)) is not None)


class TestUartBufferFlush(unittest.TestCase):
    def test_raw_repl_answer_is_released(self):
        out = feed_all(_UartBuffer(0), b'OK\x04\x04>')
        self.assertEqual(out.count('\x04'), 2)

    def test_answer_carrying_a_traceback_is_released(self):
        out = feed_all(_UartBuffer(0), b'OK\x04OSError: 28\x04>')
        self.assertEqual(out.count('\x04'), 2)
        self.assertIn('OSError: 28', out)

    def test_the_trailing_prompt_still_waits(self):
        """`>` is not a boundary; it rides out with the next flush. The
        uploader keys on the EOT pair, so this is fine."""
        buf = _UartBuffer(0)
        out = feed_all(buf, b'OK\x04\x04>')
        self.assertFalse(out.endswith('>'))
        self.assertEqual(buf.flush(), '>')

    def test_ordinary_lines_still_flush_on_newline(self):
        self.assertEqual(feed_all(_UartBuffer(0), b'hello\n'), 'hello\n')

    def test_progress_dots_still_flush(self):
        self.assertEqual(feed_all(_UartBuffer(0), b'...'), '...')

    def test_size_limit_still_applies(self):
        buf = _UartBuffer(0, flush_size=8)
        self.assertEqual(feed_all(buf, b'abcdefgh'), 'abcdefgh')
