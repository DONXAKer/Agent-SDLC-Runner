"""JSON-lines bridge to pinned upstream scorers; never receives evaluator labels."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback

kind, directory = sys.argv[1:3]
directory = Path(directory).resolve()
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HOME'] = str(directory.parents[1] / 'hf-cache')
if kind == 'nimble':
    contract = json.loads((directory / 'schema_config.json').read_text())
    snapshot = Path(os.environ['HF_HOME']) / 'hub' / ('models--' + contract['model'].replace('/', '--')) / 'snapshots' / contract['revision']
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    if not snapshot.exists():
        snapshot.symlink_to(directory.parent / 'nimble-base', target_is_directory=True)
sys.path.insert(0, str(directory))
try:
    spec = importlib.util.spec_from_file_location('inference', directory / 'inference.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules['inference'] = module
    spec.loader.exec_module(module)
    if kind == 'intern':
        engine = module.DecisionEngine(checkpoint=str(directory), device='cuda:0', max_length=8192)
        predict = engine.predict
    elif kind == 'nimble':
        engine = module.ParallelScorer(str(directory))
        def predict(request):
            schema = {}
            for key, question in request['questions'].items():
                if question['type'] == 'noul':
                    schema[key] = {'type': 'boolean', 'description': question['instructions']}
                elif question['type'] == 'choice':
                    schema[key] = {'type': 'enum', 'choices': list(question['criteria']),
                                   'description': question['instructions'] + '\n' + '\n'.join(k + ': ' + v for k, v in question['criteria'].items())}
                else:
                    raise ValueError('Unsupported experiment question type')
            result = engine.score(context=request['state'], schema=schema)
            answers = {}
            for key, field in result['fields'].items():
                probabilities = field['probabilities']
                if request['questions'][key]['type'] == 'noul':
                    value = probabilities.get('true') if isinstance(probabilities, dict) else None
                    if value is None:
                        raise ValueError('Upstream boolean probability contract differs; refusing to guess')
                    answers[key] = {'type': 'noul', 'noul': value}
                else:
                    answers[key] = {'type': 'choice', 'choice': field['prediction'], 'probabilities': probabilities}
            return {'answers': answers, 'upstream': result}
    else:
        raise ValueError('Unsupported upstream engine')
    print(json.dumps({'ready': True, 'kind': kind}), flush=True)
except Exception:
    print(json.dumps({'ready': False, 'error': traceback.format_exc()}), flush=True)
    sys.exit(2)

for line in sys.stdin:
    try:
        request = json.loads(line)
        result = predict(request)
        print(json.dumps({'response': result}), flush=True)
    except Exception:
        print(json.dumps({'error': traceback.format_exc()}), flush=True)
