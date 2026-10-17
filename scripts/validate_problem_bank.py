"""Read-only release checks for authored bank content; not a proof verifier."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.config import Problem


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'problems')
    parser.add_argument('--require-reviewed', action='store_true')
    parser.add_argument('--min-active', type=int, default=0)
    args = parser.parse_args()
    errors, ids, statements = [], {}, {}
    total, active, topics = 0, 0, Counter()
    for path in sorted(args.directory.glob('*.json')):
        if path.name == 'catalog.json':
            continue
        total += 1
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
            content = Problem.model_validate({key: raw[key] for key in Problem.model_fields})
            identifier = raw.get('id', path.stem)
            if not isinstance(identifier, str) or not identifier:
                raise ValueError('missing stable id')
            if identifier in ids:
                raise ValueError(f'duplicate id, also in {ids[identifier]}')
            ids[identifier] = path.name
            statement = ' '.join(content.statement.split()).casefold()
            if statement in statements:
                raise ValueError(f'duplicate statement, also in {statements[statement]}')
            statements[statement] = path.name
            for value in content.model_dump().values():
                if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
                    raise ValueError('control character in content; check LaTeX escaping')
            if not raw.get('topic') or not raw.get('topic_label'):
                raise ValueError('missing topic or topic_label')
            if not isinstance(raw.get('retired'), bool):
                raise ValueError('retired must explicitly be true or false')
            reviewed = raw.get('review_status') == 'reviewed' and bool(raw.get('reviewed_by'))
            if not raw['retired'] and not reviewed:
                raise ValueError('active problem has no independent review record')
            if args.require_reviewed and (not reviewed or raw['retired']):
                raise ValueError('release requires reviewed, active content')
            if not raw['retired']:
                active += 1
                topics[raw['topic']] += 1
        except (ValueError, KeyError, TypeError) as error:
            errors.append(f'{path.name}: {type(error).__name__}: {error}')
    if active < args.min_active:
        errors.append(f'active count {active} is below required {args.min_active}')
    print(json.dumps({'files': total, 'active': active, 'by_topic': dict(topics), 'errors': errors}, ensure_ascii=False, indent=2))
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
