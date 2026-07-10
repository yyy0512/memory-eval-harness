```bash
#!/usr/bin/env node
/**
 * StreamPulse Nexus ─ Deployment Script
 *
 * File: streampulse-nexus/ops/scripts/deploy.sh
 * Type: Node-based shell script (invoke with `node deploy.sh [options]`)
 * Purpose: Builds, validates, and deploys StreamPulse Nexus components in a
 *          reproducible and observable fashion.  Utilises the Command and
 *          Chain-of-Responsibility patterns to compose deployment steps that
 *          can easily be re-ordered, injected, or skipped.
 *
 * Usage examples:
 *   ./deploy.sh --env=production
 *   ./deploy.sh --env=staging --dry-run
 *   ./deploy.sh --rollback 9f3b2ad
 */

/* eslint-disable no-console */

import { promises as fs }         from 'fs';
import path                       from 'path';
import process                    from 'process';
import { fileURLToPath }          from 'url';
import { execa }                  from 'execa';
import chalk                      from 'chalk';
import yargs                      from 'yargs';
import { hideBin }                from 'yargs/helpers';
import ora                        from 'ora';
import Ajv                        from 'ajv';

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EXIT_CODES = Object.freeze({
  SUCCESS      : 0,
  VALIDATION   : 10,
  PRECONDITION : 20,
  BUILD_FAIL   : 30,
  DEPLOY_FAIL  : 40,
  CANCELLED    : 50,
  UNKNOWN      : 99
});

const logger = {
  info   : (msg) => console.log(chalk.cyan('[INFO]'), msg),
  warn   : (msg) => console.warn(chalk.yellow('[WARN]'), msg),
  error  : (msg) => console.error(chalk.red('[ERROR]'), msg),
  success: (msg) => console.log(chalk.green('[OK]'), msg)
};

// Graceful shutdown on SIGINT/SIGTERM
const signalled = {
  interrupted: false
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    signalled.interrupted = true;
    logger.warn(`Received ${sig}, attempting graceful shutdown…`);
  });
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const argv = yargs(hideBin(process.argv))
  .option('env', {
    alias   : 'e',
    choices : ['development', 'staging', 'production'],
    default : 'development',
    describe: 'Target environment for deployment'
  })
  .option('dry-run', {
    alias   : 'd',
    type    : 'boolean',
    default : false,
    describe: 'Evaluate all steps without mutating real resources'
  })
  .option('rollback', {
    alias   : 'r',
    type    : 'string',
    describe: 'Rollback to specified release identifier (skips build phase)'
  })
  .help()
  .strict()
  .argv;

// ---------------------------------------------------------------------------
// Deployment Context
// ---------------------------------------------------------------------------

class DeployContext {
  constructor({ env, dryRun, rollback }) {
    this.env         = env;
    this.dryRun      = dryRun;
    this.rollback    = rollback;
    this.releaseId   = rollback ?? `spn_${Date.now().toString(36)}`;
    this.workspace   = path.join(__dirname, '..', '..');  // repo root
    this.config      = null;        // populated after validation
    this.spinner     = ora({ color: 'cyan' });
  }
}

// ---------------------------------------------------------------------------
// Command Base Class (Chain-of-Responsibility)
// ---------------------------------------------------------------------------

class DeployCommand {
  /**
   * @param {DeployCommand|null} next Next command in chain.
   */
  constructor(next = null) {
    this.next = next;
  }

  async execute(ctx) {
    if (signalled.interrupted) {
      throw new Error('Deployment interrupted by signal.');
    }
    await this.run(ctx);
    if (this.next) {
      await this.next.execute(ctx);
    }
  }

  // Each concrete command must implement run()
  /* eslint-disable-next-line class-methods-use-this */
  async run(ctx) { // eslint-disable-line no-unused-vars
    throw new Error('run() must be implemented by subclass.');
  }
}

// ---------------------------------------------------------------------------
// Concrete Commands
// ---------------------------------------------------------------------------

class PreflightCheckCommand extends DeployCommand {
  async run(ctx) {
    ctx.spinner.start('Running preflight checks…');

    // Ensure required binaries exist
    const requiredBins = ['git', 'docker', 'kubectl'];
    const checks = requiredBins.map(async (bin) => {
      try {
        await execa.command(`which ${bin}`);
      } catch {
        throw new Error(`Required binary not found: ${bin}`);
      }
    });

    await Promise.all(checks);

    ctx.spinner.succeed('Preflight checks passed.');
  }
}

class ValidateConfigCommand extends DeployCommand {
  async run(ctx) {
    ctx.spinner.start('Validating configuration…');

    const configPath = path.join(ctx.workspace, 'config', `${ctx.env}.json`);
    try {
      const contents = await fs.readFile(configPath, 'utf8');
      ctx.config = JSON.parse(contents);
    } catch (err) {
      ctx.spinner.fail();
      throw new Error(`Unable to read config: ${configPath} (${err.message})`);
    }

    // Basic schema validation
    const schema = {
      type      : 'object',
      required  : ['cluster', 'registry', 'services'],
      properties: {
        cluster  : { type: 'string' },
        registry : { type: 'string' },
        services : {
          type : 'array',
          items: {
            type      : 'object',
            required  : ['name', 'dockerfile', 'k8sManifest'],
            properties: {
              name       : { type: 'string' },
              dockerfile : { type: 'string' },
              k8sManifest: { type: 'string' }
            }
          }
        }
      }
    };

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    if (!validate(ctx.config)) {
      ctx.spinner.fail();
      throw new Error(`Configuration validation failed: ${ajv.errorsText(validate.errors)}`);
    }

    ctx.spinner.succeed('Configuration validated.');
  }
}

class BuildImagesCommand extends DeployCommand {
  async run(ctx) {
    if (ctx.rollback) {
      logger.info('Rollback requested ─ skipping build phase.');
      return;
    }

    ctx.spinner.start('Building Docker images…');

    for (const svc of ctx.config.services) {
      const tag = `${ctx.config.registry}/${svc.name}:${ctx.releaseId}`;
      logger.info(`Building ${svc.name} (${tag})`);
      if (ctx.dryRun) {
        logger.info(chalk.gray('[dry-run] docker build …'));
        continue;
      }

      try {
        await execa('docker', [
          'build',
          '-f',
          svc.dockerfile,
          '-t',
          tag,
          '.'
        ], { cwd: ctx.workspace, stdio: 'inherit' });
      } catch (err) {
        ctx.spinner.fail();
        throw new Error(`Failed to build image for ${svc.name}: ${err.message}`);
      }
    }

    ctx.spinner.succeed('Docker images built.');
  }
}

class SecurityScanCommand extends DeployCommand {
  async run(ctx) {
    if (ctx.dryRun) {
      logger.info(chalk.gray('[dry-run] security scan skipped.'));
      return;
    }
    ctx.spinner.start('Running container security scans…');

    for (const svc of ctx.config.services) {
      const tag = `${ctx.config.registry}/${svc.name}:${ctx.releaseId}`;
      logger.info(`Scanning ${tag}`);

      // Placeholder for real scanner, ex: trivy
      try {
        await execa('trivy', ['--quiet', 'image', tag], { stdio: 'inherit' });
      } catch (err) {
        ctx.spinner.fail();
        throw new Error(`Security scan failed for ${svc.name}: ${err.message}`);
      }
    }

    ctx.spinner.succeed('Security scans completed.');
  }
}

class PushImagesCommand extends DeployCommand {
  async run(ctx) {
    if (ctx.rollback) {
      logger.info('Rollback requested ─ skipping push images.');
      return;
    }
    ctx.spinner.start('Pushing images to registry…');
    for (const svc of ctx.config.services) {
      const tag = `${ctx.config.registry}/${svc.name}:${ctx.releaseId}`;
      logger.info(`Pushing ${tag}`);
      if (ctx.dryRun) {
        logger.info(chalk.gray('[dry-run] docker push …'));
        continue;
      }
      try {
        await execa('docker', ['push', tag], { stdio: 'inherit' });
      } catch (err) {
        ctx.spinner.fail();
        throw new Error(`Failed to push ${svc.name}: ${err.message}`);
      }
    }
    ctx.spinner.succeed('Images pushed.');
  }
}

class DeployK8sCommand extends DeployCommand {
  async run(ctx) {
    ctx.spinner.start('Deploying to Kubernetes…');

    const applyOrRollback = ctx.rollback ? 'rollout undo' : 'apply -f';
    for (const svc of ctx.config.services) {
      const manifest = path.join(ctx.workspace, svc.k8sManifest);
      if (ctx.dryRun) {
        logger.info(chalk.gray(`[dry-run] kubectl ${applyOrRollback} ${manifest}`));
        continue;
      }

      try {
        if (ctx.rollback) {
          await execa('kubectl', ['rollout', 'undo', `deployment/${svc.name}`, `--to-revision=${ctx.rollback}`], { stdio: 'inherit' });
        } else {
          await execa('kubectl', ['apply', '-f', manifest], { stdio: 'inherit' });
          // annotate with releaseId
          await execa('kubectl', ['annotate', '--overwrite', '-f', manifest, `release-id=${ctx.releaseId}`], { stdio: 'inherit' });
        }
      } catch (err) {
        ctx.spinner.fail();
        throw new Error(`Kubernetes deploy failed for ${svc.name}: ${err.message}`);
      }
    }

    ctx.spinner.succeed('Kubernetes deployment successful.');
  }
}

class VerifyHealthCommand extends DeployCommand {
  async run(ctx) {
    if (ctx.dryRun) {
      logger.info(chalk.gray('[dry-run] health verification skipped.'));
      return;
    }

    ctx.spinner.start('Verifying deployment health…');

    try {
      // Example: ensure all pods are ready
      await execa('kubectl', [
        'wait',
        '--for=condition=Ready',
        'pods',
        '--all',
        '--namespace', ctx.config.cluster,
        '--timeout=180s'
      ], { stdio: 'inherit' });
    } catch (err) {
      ctx.spinner.fail();
      throw new Error(`Health verification failed: ${err.message}`);
    }

    ctx.spinner.succeed('All services are healthy.');
  }
}

class NotifyCommand extends DeployCommand {
  async run(ctx) {
    ctx.spinner.start('Sending deployment notifications…');
    const message = ctx.rollback
      ? `Rollback executed to release ${ctx.rollback} in ${ctx.env}.`
      : `Deployment ${ctx.releaseId} completed for ${ctx.env}.`;

    // Placeholder webhook notification
    try {
      if (ctx.dryRun) {
        logger.info(chalk.gray(`[dry-run] notify ← "${message}"`));
      } else {
        await execa('curl', [
          '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-d', JSON.stringify({ text: message }),
          'https://hooks.example.com/deploy'
        ]);
      }
    } catch (err) {
      ctx.spinner.fail();
      logger.error(`Failed to send notification: ${err.message}`);
      return; // Non-fatal
    }

    ctx.spinner.succeed('Notification sent.');
  }
}

// ---------------------------------------------------------------------------
// Pipeline Builder
// ---------------------------------------------------------------------------

function buildPipeline(ctx) {
  // Compose commands in reverse because each constructor takes `next`
  const pipeline =
    new NotifyCommand(
      new VerifyHealthCommand(
        new DeployK8sCommand(
          new PushImagesCommand(
            new SecurityScanCommand(
              new BuildImagesCommand(
                new ValidateConfigCommand(
                  new PreflightCheckCommand(null))))))));

  // Optionally skip Build/Security/Push commands on rollback
  if (ctx.rollback) {
    pipeline.next.next.next = pipeline.next.next.next.next; // remove BuildImagesCommand chain
  }

  return pipeline;
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

(async () => {
  const ctx = new DeployContext({
    env    : argv.env,
    dryRun : argv['dry-run'],
    rollback: argv.rollback
  });

  logger.info(`StreamPulse Nexus Deploy ─ env: ${ctx.env}, dry-run: ${ctx.dryRun ? 'yes' : 'no'}, rollback: ${ctx.rollback ?? 'n/a'}`);

  try {
    const pipeline = buildPipeline(ctx);
    await pipeline.execute(ctx);
    logger.success('Deployment pipeline finished successfully.');
    process.exit(EXIT_CODES.SUCCESS);
  } catch (err) {
    logger.error(err.message);
    if (err.stack) {
      logger.error(err.stack.split('\n').slice(1).join('\n'));
    }
    const code = (() => {
      switch (true) {
        case /validation/i.test(err.message):
          return EXIT_CODES.VALIDATION;
        case /build/i.test(err.message):
          return EXIT_CODES.BUILD_FAIL;
        case /deploy/i.test(err.message):
          return EXIT_CODES.DEPLOY_FAIL;
        case /preflight/i.test(err.message):
          return EXIT_CODES.PRECONDITION;
        case /interrupted/i.test(err.message):
          return EXIT_CODES.CANCELLED;
        default:
          return EXIT_CODES.UNKNOWN;
      }
    })();
    process.exit(code);
  }
})();
```