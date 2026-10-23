"""Local-only HTTP transport over JSONL; runs beside the isolated Linux servers."""
import json
import sys
import urllib.error
import urllib.request

print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        port = request['port']
        path = request['path']
        if port not in (30000, 30120) or not path.startswith('/') or path.startswith('//'):
            raise ValueError('Invalid local server destination')
        body = json.dumps(request['body']).encode() if 'body' in request else None
        wire = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=body,
                                      headers={'content-type': 'application/json'})
        try:
            response = urllib.request.urlopen(wire, timeout=request.get('timeout', 60))
        except urllib.error.HTTPError as error:
            response = error
        with response:
            text = response.read().decode()
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                value = text
            result = {'status': response.status, 'body': value}
        print(json.dumps({'response': result}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
