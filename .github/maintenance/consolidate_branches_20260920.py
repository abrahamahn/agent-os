"""One-shot, repository-scoped consolidation; never executes project code."""
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

REPO = os.environ['GITHUB_REPOSITORY']
assert REPO.startswith('abrahamahn/') and REPO != 'abrahamahn/ganbate'
TOKEN = os.environ['GH_TOKEN']
ROOT = pathlib.Path(os.environ['RUNNER_TEMP'])
OUT = ROOT / 'branch-consolidation-report'
OUT.mkdir(exist_ok=True)
WORK = ROOT / 'branch-consolidation-work'
PREFIX = 'branch-cleanup-20260920-' + os.environ['GITHUB_RUN_ID']
REPORT = {'repository': REPO, 'initial_branches': [], 'merged_prs': [],
          'rebase_requests': [], 'branch_cleanup': [], 'blocked': {}, 'errors': []}


def api(path, method='GET', data=None):
    request = urllib.request.Request(
        'https://api.github.com/' + path,
        data=None if data is None else json.dumps(data).encode(), method=method,
        headers={'Authorization': 'Bearer ' + TOKEN,
                 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read()
        return json.loads(body) if body else None


def pages(path):
    result = []
    for page in range(1, 101):
        batch = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError('Pagination incomplete; refusing partial inventory')


def git(*args, check=True):
    result = subprocess.run(['git', '-C', str(WORK), *args], text=True,
                            capture_output=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError('git ' + args[0] + ': ' + result.stderr[-2000:])
    return result


def equivalent(sha):
    contained = git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main', check=False)
    if contained.returncode == 0:
        return 'ancestor'
    if contained.returncode != 1:
        return None
    common = git('merge-base', sha, 'refs/remotes/origin/main', check=False)
    if common.returncode != 0:
        return None
    cherry = git('cherry', 'refs/remotes/origin/main', sha, check=False)
    if cherry.returncode == 0 and cherry.stdout.strip() and all(
            line.startswith('- ') for line in cherry.stdout.splitlines()):
        return 'patch-equivalent'
    return None


def checks_ready(sha):
    statuses = api(f'repos/{REPO}/commits/{sha}/status')
    if statuses.get('total_count', 0) and statuses.get('state') != 'success':
        return False, 'commit statuses: ' + str(statuses.get('state'))
    runs = api(f'repos/{REPO}/commits/{sha}/check-runs?per_page=100')
    if runs.get('total_count', 0) > 100:
        return False, 'more than 100 checks; manual review required'
    for run in runs.get('check_runs', []):
        if run.get('status') != 'completed' or run.get('conclusion') not in ('success', 'neutral', 'skipped'):
            return False, 'check: ' + run.get('name', '') + ' ' + str(run.get('conclusion') or run.get('status'))
    return True, 'available checks passed or no checks configured'


def main():
    metadata = api('repos/' + REPO)
    if metadata.get('archived') or metadata['owner']['login'] != 'abrahamahn':
        raise RuntimeError('Repository is outside the permitted writable scope')
    branches = pages(f'repos/{REPO}/branches')
    REPORT['initial_branches'] = [{'name': b['name'], 'sha': b['commit']['sha']} for b in branches]
    if not any(b['name'] == 'main' for b in branches):
        raise RuntimeError('No main branch; no branch changes made')
    subprocess.run(['gh', 'auth', 'setup-git'], check=True, capture_output=True, text=True)
    subprocess.run(['git', 'clone', '--quiet', '--no-checkout',
                    f'https://github.com/{REPO}.git', str(WORK)], check=True, timeout=300)
    for b in branches:
        tag = PREFIX + '/original/' + b['name']
        git('push', 'origin', b['commit']['sha'] + ':refs/tags/' + tag)
    REPORT['backup_tag_prefix'] = PREFIX
    if metadata['default_branch'] != 'main':
        try:
            metadata = api('repos/' + REPO, 'PATCH', {'default_branch': 'main'})
            REPORT['default_branch_changed'] = True
        except urllib.error.HTTPError as exc:
            REPORT['errors'].append('Default branch change denied: HTTP ' + str(exc.code))
    REPORT['default_branch'] = metadata['default_branch']
    method = 'merge' if metadata.get('allow_merge_commit') else ('rebase' if metadata.get('allow_rebase_merge') else 'squash')
    requested = set()
    for attempt in range(15):
        prs = pages(f'repos/{REPO}/pulls?state=open')
        prs = [p for p in prs if p['base']['ref'] == 'main'
               and p['head'].get('repo') and p['head']['repo']['full_name'] == REPO]
        if not prs:
            break
        waiting = False
        for listed in prs:
            number = listed['number']
            try:
                p = api(f'repos/{REPO}/pulls/{number}')
                if p.get('state') != 'open' or p.get('draft'):
                    continue
                branch, sha = p['head']['ref'], p['head']['sha']
                key = str(number)
                if p.get('mergeable') is True:
                    ready, reason = checks_ready(sha)
                    if not ready or p.get('mergeable_state') == 'blocked':
                        REPORT['blocked'][key] = reason if not ready else 'GitHub branch requirements block merging'
                        waiting |= 'pending' in reason or 'in_progress' in reason or 'queued' in reason
                        continue
                    merged = api(f'repos/{REPO}/pulls/{number}/merge', 'PUT', {'sha': sha, 'merge_method': method})
                    if merged.get('merged'):
                        REPORT['merged_prs'].append({'number': number, 'branch': branch, 'head_sha': sha,
                                                     'merge_sha': merged.get('sha'), 'method': method})
                        REPORT['blocked'].pop(key, None)
                        print('MERGED', number, branch, flush=True)
                        waiting = True
                elif p.get('mergeable') is None:
                    waiting = True
                else:
                    REPORT['blocked'][key] = 'merge conflicts'
                    if p['user']['login'] == 'dependabot[bot]' and number not in requested:
                        comment = api(f'repos/{REPO}/issues/{number}/comments', 'POST', {'body': '@dependabot rebase'})
                        requested.add(number)
                        REPORT['rebase_requests'].append({'number': number, 'comment_id': comment['id']})
                        print('REQUESTED_REBASE', number, branch, flush=True)
                    waiting |= number in requested
            except urllib.error.HTTPError as exc:
                REPORT['blocked'][str(number)] = 'GitHub API HTTP ' + str(exc.code) + ': ' + exc.read().decode()[:500]
                if exc.code in (403, 429):
                    break
        if not waiting:
            break
        if attempt < 14:
            time.sleep(10)
    git('fetch', '--quiet', '--prune', '--tags', 'origin')
    live = pages(f'repos/{REPO}/branches')
    for b in live:
        name, sha = b['name'], b['commit']['sha']
        item = {'branch': name, 'sha': sha}
        if name == 'main' or name == metadata['default_branch'] or b.get('protected'):
            item['status'] = 'retained-main-default-or-protected'
        else:
            git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main')
            proof = equivalent(sha)
            if proof:
                tag = PREFIX + '/final/' + name
                result = git('push', '--atomic', '--force-with-lease=refs/heads/' + name + ':' + sha,
                             'origin', sha + ':refs/tags/' + tag, ':refs/heads/' + name, check=False)
                item.update(status='archived-and-deleted' if result.returncode == 0 else 'retained-push-rejected', proof=proof)
                if result.returncode == 0:
                    item['backup_tag'] = tag
                else:
                    item['detail'] = result.stderr[-2000:]
            else:
                item['status'] = 'retained-unmerged'
        REPORT['branch_cleanup'].append(item)
        print('BRANCH', json.dumps(item), flush=True)
    REPORT['remaining_branches'] = [{'name': b['name'], 'sha': b['commit']['sha']}
                                    for b in pages(f'repos/{REPO}/branches')]
    if REPO.split('/')[1] in ('AbeOS', 'mpsm', 'abe-website', 'blendtune-nextjs', 'bslt-legacy'):
        git('fetch', '--quiet', '--prune', '--tags', 'origin')
        git('bundle', 'create', str(OUT / 'repository.bundle'), '--all')


try:
    main()
except Exception as exc:
    REPORT['errors'].append(type(exc).__name__ + ': ' + str(exc)[:2000])
finally:
    (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write('## One-time branch consolidation\n```json\n' + json.dumps(REPORT, indent=2) + '\n```\n')
    print('FINAL_REPORT', json.dumps(REPORT), flush=True)
