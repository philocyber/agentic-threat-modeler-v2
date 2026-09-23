import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('converter', Path(__file__).parents[1] / 'pdf_to_markdown.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ConverterTests(unittest.TestCase):
    def test_recursive_mapping_preserves_subfolders_and_uppercase_extension(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / 'input'
            (source / 'books').mkdir(parents=True)
            (source / 'books' / 'guide.PDF').touch()
            jobs = converter.plan([source], root / 'review')
            self.assertEqual(jobs[0][1], (root / 'review/books/guide.md').resolve())

    def test_refuses_colliding_names_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for folder in ['a', 'b']:
                (root / folder).mkdir()
                (root / folder / 'guide.pdf').touch()
            with self.assertRaisesRegex(ValueError, 'collision'):
                converter.plan([root / 'a', root / 'b'], root / 'review')
            (root / 'review').mkdir()
            target = root / 'review/guide.md'
            target.write_text('Reviewed corrections')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                converter.plan([root / 'a'], root / 'review')
            self.assertEqual(target.read_text(), 'Reviewed corrections')

    def test_rejects_output_inside_input(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'outside'):
                converter.plan([Path(root)], Path(root) / 'review')

    def test_table_preserves_first_row_and_escapes_cells(self):
        table = converter.markdown_table([['A|B', 'First\nsecond'], ['row', None]])
        self.assertIn('Column 1', table)
        self.assertIn('A\\|B', table)
        self.assertIn('First<br>second', table)
        self.assertIn('row', table)

    def test_bad_pdf_does_not_stop_batch(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'bad.pdf').write_text('invalid')
            (root / 'also-bad.pdf').write_text('also invalid')
            self.assertEqual(converter.main([str(root / 'bad.pdf'), str(root / 'also-bad.pdf'), '--output', str(root / 'review')]), 1)
            import json
            report = json.loads((root / 'review/conversion-report.json').read_text())
            self.assertEqual(len(report['documents']), 2)
            self.assertTrue(all(d['status'] == 'failed' for d in report['documents']))


if __name__ == '__main__':
    unittest.main()
