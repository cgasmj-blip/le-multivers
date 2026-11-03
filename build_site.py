from pathlib import Path
import hashlib, json, os, shutil
root=Path(__file__).resolve().parent
out=root/'_site'
if out.exists():shutil.rmtree(out)
out.mkdir()
assets={}
for name in ('app.js','style.css','config.js'):
 data=(root/name).read_bytes()
 hashed=f'{Path(name).stem}.{hashlib.sha256(data).hexdigest()[:12]}{Path(name).suffix}'
 (out/hashed).write_bytes(data)
 assets[name]=hashed
for name in ('index.html','gestion.html'):
 html=(root/name).read_text()
 for original,hashed in assets.items():html=html.replace(f'"{original}"',f'"{hashed}"')
 (out/name).write_text(html)
shutil.copytree(root/'assets',out/'assets')
(out/'.nojekyll').touch()
(out/'version.json').write_text(json.dumps({'version':os.environ.get('GITHUB_SHA','local'),'assets':assets}))
for html in out.glob('*.html'):
 content=html.read_text()
 for original,hashed in assets.items():
  assert f'"{original}"' not in content
  assert f'"{hashed}"' in content
  assert (out/hashed).is_file()
print('Site préparé avec des noms de fichiers versionnés.')
