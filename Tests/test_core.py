import unittest
from thePrivator.core import Core

class TestCore(unittest.TestCase):

    def test_load_profiles_returns_list(self):
        core = Core()
        core.load_profiles()
        self.assertIsInstance(core.loaded_profiles, list)

    def test_isupper(self):
        self.assertTrue('FOO'.isupper())
        self.assertFalse('Foo'.isupper())

    def test_split(self):
        s = 'hello world'
        self.assertEqual(s.split(), ['hello', 'world'])
        # check that s.split fails when the separator is not a string
        with self.assertRaises(TypeError):
            s.split(2)

if __name__ == '__main__':
    unittest.main()
