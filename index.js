'use strict'

const Status = Object.seal({
  FAIL: Symbol('failure'),
  SUCCESS: Symbol('success'),
  SKIPPED: Symbol('success'),
  PROGRESS: Symbol('pending')
})

module.exports = (robot) => {
  robot.on('pull_request.synchronize', checkChangelog)
  robot.on('pull_request.opened', checkChangelog)
  robot.on('pull_request.reopened', checkChangelog)
  robot.on('pull_request.labeled', checkChangelog)
  robot.on('pull_request.unlabeled', checkChangelog)

  const itself = _ => _

  async function changedFiles (context) {
    return context.github.paginate(context.github.pulls.listFiles, context.pullRequest(), res => {
      return res.data.map(itself)
    })
  }

  const slash = '/'

  function isRegexp (pattern) {
    return pattern.startsWith(slash) && pattern.endsWith(slash)
  }

  function matches (filename, patterns) {
    return patterns.some(pattern => {
      if (isRegexp(pattern)) {
        return filename.match(pattern.substr(1, pattern.length - 2))
      } else {
        return filename.includes(pattern)
      }
    })
  }

  const allowedStatuses = ['modified', 'added']

  function changelogStatus (config, changes) {
    const changelog = changes[config.filename || 'CHANGELOG.md']
    const include = config.include || []
    const exclude = config.exclude || []

    const changed = Object.values(changes)
      .filter(file => matches(file.filename, include))
      .filter(file => !matches(file.filename, exclude))
      .some(itself)

    if (changelog) {
      if (allowedStatuses.includes(changelog.status)) {
        return Status.SUCCESS
      } else {
        return Status.FAIL
      }
    }

    if (changed) {
      return Status.PROGRESS
    }

    return Status.SUCCESS
  }

  function descriptionFor (status) {
    switch (status) {
      case Status.SUCCESS:
        return 'changelog entry included'
      case Status.SKIPPED:
        return 'changelog entry not needed'
      case Status.PROGRESS:
        return 'changelog entry missing'
      case Status.FAIL:
        return 'changelog could not be detected'
    }
  }

  async function setStatus (context, status) {
    log(context, { status: status })

    const params = context.repo({
      sha: context.payload.pull_request.head.sha,
      state: status.toString().slice(7, -1),
      target_url: 'https://github.com/apps/probot-changelog',
      description: descriptionFor(status),
      context: 'changelog'
    })
    return context.github.repos.createCommitStatus(params)
  }

  function log (context, object) {
    const ctx = { event: context.event, action: context.payload.action }
    const url = context.payload.pull_request.html_url

    robot.log(ctx, context.issue({ url, ...object }))
  }

  async function hasLabel (context, label) {
    if (!label) { return }

    const l = label.toLowerCase()
    const labels = await context.github.issues.listLabelsOnIssue(context.issue())

    return labels.data.some(label => label.name.toLowerCase() === l)
  }

  async function skipChangelog (context, config) {
    const skipLabel = config.skipLabel || 'skip-changelog'

    return hasLabel(context, skipLabel)
  }

  async function checkChangelog (context) {
    const config = await context.config('changelog.yml')

    if (!config) {
      // don't try to run analysis without a config
      log(context, { status: 'missing config' })
      return
    }

    const files = await changedFiles(context)

    if (await skipChangelog(context, config) || !files.some(itself)) {
      log(context, { status: 'skipping changelog' })
      return setStatus(context, Status.SKIPPED)
    }

    const changes = Object.assign.apply(null, files.map((file) => { return { [file.filename]: file } }))
    const status = changelogStatus(config, changes)

    return setStatus(context, status)
  }
}
