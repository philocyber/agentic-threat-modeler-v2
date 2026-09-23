import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parents[1]))
from pdf_to_markdown import digest, words
from promote_pdf_markdown import promote, update_page_indices
from validate_pdf_markdown import recover_blocks


class WorkflowTests(unittest.TestCase):
    def fixture(self,root):
        corpus,converted,archive=root/'corpus',root/'converted',root/'archive'
        (corpus/'technical').mkdir(parents=True);converted.mkdir()
        pdf=corpus/'technical/source.pdf';pdf.write_bytes(b'original source fixture')
        md=converted/'source.md';md.write_text('## Source page 1\n\nVerified source text')
        record={'source':'technical/source.pdf','output':'source.md','source_sha256':digest(pdf),
                'output_sha256':digest(md),'validation':{'passed':True}}
        (converted/'conversion-report.json').write_text(json.dumps({'documents':[record]}))
        return corpus,converted,archive

    def test_promotes_verified_markdown_and_preserves_exact_original(self):
        with tempfile.TemporaryDirectory() as temp:
            corpus,converted,archive=self.fixture(Path(temp))
            receipt=promote(corpus,converted,archive)
            self.assertFalse((corpus/'technical/source.pdf').exists())
            self.assertEqual((archive/'technical/source.pdf').read_bytes(),b'original source fixture')
            self.assertEqual((corpus/'technical/source.md').read_bytes(),(converted/'source.md').read_bytes())
            self.assertEqual(json.loads(receipt.read_text())['status'],'promoted')

    def test_page_index_preserves_source_pages_and_backs_up_previous_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);corpus,converted,archive=self.fixture(root)
            indices=root/'indices';indices.mkdir()
            old=indices/'source.tree.json';old.write_text('{"old":true}')
            receipt=promote(corpus,converted,archive)
            update_page_indices(corpus,receipt,indices)
            tree=json.loads(old.read_text())
            self.assertEqual(tree['nodes'][0]['page_start'],1)
            self.assertEqual(tree['nodes'][0]['children'][0]['text'],'Verified source text')
            self.assertEqual((archive/'previous-page-indices/source.tree.json').read_text(),'{"old":true}')

    def test_hash_mismatch_leaves_source_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            corpus,converted,archive=self.fixture(Path(temp))
            (converted/'source.md').write_text('Changed after validation')
            with self.assertRaisesRegex(ValueError,'Files changed'):
                promote(corpus,converted,archive)
            self.assertTrue((corpus/'technical/source.pdf').exists())
            self.assertFalse(archive.exists())

    def test_failed_copy_rolls_back_active_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            corpus,converted,archive=self.fixture(Path(temp))
            original=digest
            def fail_final(path):
                if path==(corpus/'technical/source.md').resolve():return 'mismatch'
                return original(path)
            with patch('promote_pdf_markdown.digest',side_effect=fail_final):
                with self.assertRaisesRegex(ValueError,'Promotion verification'):
                    promote(corpus,converted,archive)
            self.assertTrue((corpus/'technical/source.pdf').exists())
            self.assertFalse((corpus/'technical/source.md').exists())
            self.assertEqual(json.loads((archive/'migration-receipt.json').read_text())['status'],'rolled_back')

    def test_normalizes_table_line_wrapping_for_coverage(self):
        self.assertEqual(words('communication'),words('communi-<br>cation'))

    def test_recovers_omitted_source_text(self):
        class Page:
            def get_text(self,mode=None,sort=False):
                if mode=='blocks':return [(0,0,1,1,'Required source qualification',0,0)]
                return 'Required source qualification'
        content,count=recover_blocks(Page(),'')
        self.assertIn('Required source qualification',content)
        self.assertEqual(count,1)


if __name__=='__main__':unittest.main()
