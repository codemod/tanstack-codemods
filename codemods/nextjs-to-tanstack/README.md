# @codemod/nextjs-to-tanstack

migrate a project from the Next.js App Router to TanStack

## Installation

```bash
# Install from registry
codemod run @codemod/nextjs-to-tanstack

# Or run locally
codemod run -w workflow.yaml
```

## Usage

This codemod transforms typescript code by:

- Converting `var` declarations to `const`/`let`
- Removing debug statements
- Modernizing syntax patterns

## Development

```bash
# Test the transformation
npm test

# Validate the workflow
codemod validate -w workflow.yaml

# Publish to registry
codemod login
codemod publish
```

## License

MIT 