# Security policy

Only the latest release receives fixes. Report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/ciatlas/simulci/security/advisories/new), not in a public
issue.

simulci reads untrusted input: the workflow, action, test and mock files of the repository it simulates, and in the web
app pasted YAML. Relevant reports include anything that lets that input read files outside the repository, exhaust
memory or CPU disproportionately (YAML aliases, matrix size), or execute code. The engine never executes a workflow.
