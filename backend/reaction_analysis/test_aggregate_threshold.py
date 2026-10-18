import unittest

from .aggregate_threshold import sweep, choose


def windows(actions, background):
    return {'actions': [{'score': x} for x in actions], 'background': [{'score': x} for x in background]}


class AggregateThresholdTests(unittest.TestCase):
    def test_separable_windows_choose_boundary_with_strict_comparison(self):
        selected = choose(sweep([windows([3, 4], [1, 2])]))
        self.assertEqual(selected['cutoff'], 2)
        self.assertEqual(selected['reaction_hits'], 2)
        self.assertEqual(selected['background_triggers'], 0)
        self.assertEqual(selected['macro_balanced_accuracy'], 1)

    def test_duplicate_record_rows_do_not_increase_that_runs_macro_weight(self):
        a = windows([2, 2], [1, 1])
        b = windows([1], [2])
        before = sweep([a, b]); after = sweep([windows([2]*40, [1]*40), b])
        self.assertEqual([r['macro_balanced_accuracy'] for r in before],
                         [r['macro_balanced_accuracy'] for r in after])

    def test_identical_distributions_tie_prefers_fewer_triggers(self):
        selected = choose(sweep([windows([1, 2], [1, 2])]))
        self.assertEqual(selected['macro_balanced_accuracy'], .5)
        self.assertEqual(selected['cutoff'], 2)
        self.assertEqual(selected['background_triggers'], 0)


if __name__ == '__main__':
    unittest.main()
