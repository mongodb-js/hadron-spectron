const assert = require('assert');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const { Application } = require('spectron');
const electronPath = require('electron');
const path = require('path');
const debug = require('debug')('hadron-spectron:app');

chai.use(chaiAsPromised);

/**
 * The default timeout for selectors.
 */
const TIMEOUT = 15000;

/**
 * A long running operation timeout.
 */
const LONG_TIMEOUT = 30000;

/**
 * The wait for timeout error.
 */
const WAIT_FOR_TIMEOUT = 'WaitForTimeoutError';

/**
 * The wait until timeout error.
 */
const WAIT_UNTIL_TIMEOUT = 'WaitUntilTimeoutError';

/**
 * The progressive timeouts when searching for elements.
 */
const TIMEOUTS = [1000, 2000, 3000, 5000, 8000];

/**
 * Determine if the error is a timeout error.
 *
 * @param {Error} e - The error.
 *
 * @returns {Boolean} If the error is a timeout error.
 */
function isTimeoutError(e) {
  return e.type === WAIT_FOR_TIMEOUT || e.type === WAIT_UNTIL_TIMEOUT;
}

/**
 * Waits for an element on the page in progressive increments, using
 * fibonacci.
 *
 * @param {Function} fn - The function to use for waiting.
 * @param {String} selector - The selector for the element.
 * @param {Boolean} reverse - Whether to revers the conditions.
 * @param {Number} index - The timeout index to use from TIMEOUTS.
 *
 * @return {Function}  return value of the `fn` function.
 */
function progressiveWait(fn, selector, reverse, index) {
  const timeout = TIMEOUTS[index];
  debug(`Looking for element ${selector} with timeout ${timeout}ms`);
  return fn(selector, timeout, reverse).catch(function(e) {
    if (isTimeoutError(e) && timeout !== 8000) {
      return progressiveWait(fn, selector, reverse || false, index + 1);
    }
    throw e;
  });
}

/**
 * Add the extended wait commands for Compass.
 *
 * @param {Object} client   spectron client to add the wait commands to.
 */
function addExtendedWaitCommands(client) {
  /**
   * Wait for an element to exist in the Compass test suite.
   *
   * @param {String} selector - The CSS selector for the element.
   * @param {Boolean} reverse - Whether to reverse the wait.
   */
  client.addCommand('waitForExistInCompass', function(selector, reverse) {
    return progressiveWait(this.waitForExist.bind(this), selector, reverse, 0);
  });

  /**
   * Wait for an element to be visible in the Compass test suite.
   *
   * @param {String} selector - The CSS selector for the element.
   * @param {Boolean} reverse - Whether to reverse the wait.
   */
  client.addCommand('waitForVisibleInCompass', function(selector, reverse) {
    return progressiveWait(
      this.waitForVisible.bind(this),
      selector,
      reverse,
      0
    );
  });

  /**
   * Waits until the currently selected window is visible to the user.
   *
   * @param {Number} timeout - The amount of time to wait.
   */
  client.addCommand('waitUntilWindowVisibleInCompass', function(timeout) {
    return this.waitUntil(function() {
      debug('Waiting for window to become visible');
      return this.browserWindow.isVisible().then(function(visible) {
        return visible;
      });
    }, timeout).then(
      function() {},
      function(error) {
        error.message = `waitUntilWindowVisibleInCompass ${error.message}`;
        throw error;
      }
    );
  });
}

/**
 * Represents a testable hadron app with Spectron.
 */
class App {
  /**
   * Create the application given the root directory to the app.
   *
   * @param {String} root - The root directory.
   * @param {String} appRoot - The root of the electron app.
   */
  constructor(root, appRoot) {
    this.root = root;
    this.appRoot = appRoot === undefined ? root : appRoot;

    this.appId = Date.now();
    this.debug = require('debug')(`hadron-spectron:app-${this.appId}`);

    this.app = new Application({
      path: this.electronExecutable(),
      args: [this.appRoot],
      env: process.env,
      cwd: this.appRoot,
      chromeDriverLogPath: path.join(
        this.root,
        `hadron-spectron_${this.appId}_chromedriver.log`
      ),
      webdriverLogPath: path.join(
        this.root,
        `hadron-spectron_${this.appId}_webdriver`
      )
    });
    this.debug(
      'Created spectron.Application'
      // this.app.getSettings()
    );
  }

  /**
   * Get the path to the electron executable.
   *
   * TODO (@imlucas) Allow setting via `ELECTRON_EXECUTABLE` environment
   * variable or something if we want to allow functional testing of
   * fully packaged Compass releases instead of just using electron prebuilt.
   *
   * @returns {String} - The path.
   */
  electronExecutable() {
    return electronPath;
  }

  /**
   * Launch the application.
   *
   * @param {Function} addCustomCommands - A function to add custom commands.
   *
   * @returns {Application} - The spectron application.
   */
  launch(addCustomCommands) {
    this.debug('launching! waiting for app.start...');
    return this.app
      .start()
      .then(() => {
        this.debug('app.start() promise resolved');
        chaiAsPromised.transferPromiseness = this.app.transferPromiseness;
        this.client = this.app.client;
        addExtendedWaitCommands(this.client);
        if (addCustomCommands !== undefined) {
          addCustomCommands(this.client);
        }
        chai.should().exist(this.client);
        // The complexity here is to be able to handle applications that have a
        // standard 1 window setup and those with 2 where the first is a loading
        // window to animated while the other is loading. In order for us to
        // figure this out, we first get the window handles.
        this.debug('app started! Finding windows...');
        return this.client.windowHandles();
      })
      .then(session => {
        // If the window handles have a 2nd window, we know we are in a loading
        // window situation, and that the content we are actually interested in is
        // in the 2nd window, which is currently hidden.
        if (session.value[1]) {
          this.debug(
            'loading window detected. assuming real app window is behind it.'
          );
          return this.client.windowByIndex(1);
        }
        this.debug('no loading window detected');
        return this.client.windowByIndex(0);
      })
      .then(() => {
        // Now we wait for our focused window to become visible to the user. In the
        // case of a single window this is already the case. In the case of a loading
        // window this will wait until the main content window is ready.
        this.debug(
          'Waiting up to %dms for focused window to become visible to the user...',
          LONG_TIMEOUT
        );
        return this.client.waitUntilWindowVisibleInCompass(LONG_TIMEOUT);
      })
      .then(() => {
        // Once we ensure the window is visible, we ensure all the content has loaded.
        // This is the same for both setups.
        this.debug(
          'Waiting up to %dms for focused window to load...',
          LONG_TIMEOUT
        );
        return this.client.waitUntilWindowLoaded(LONG_TIMEOUT);
      })
      .then(() => {
        this.debug('app window loaded and ready!');
        return this;
      })
      .catch(error => {
        this.debug(
          'hadron-spectron: App failed to launch due to error:',
          error
        );
        /* eslint no-console:0 */
        console.error(
          'hadron-spectron: App failed to launch due to error:',
          error
        );
        throw error;
      });
  }

  /**
   * Quit the application.
   * @returns {Promise} - Resolves true if actually quit, false if called but no/not running `app`.
   */
  quit() {
    this.debug('quitting app');
    if (!this.app || !this.app.isRunning()) {
      this.debug('no app or app not running');
      return Promise.resolve(false);
    }
    return this.app
      .stop()
      .then(() => {
        assert.equal(this.app.isRunning(), false);
        debug('app quit. goodbye.');
        return true;
      })
      .catch(err => {
        debug('hadron-spectron: App failed to quit due to error:', err);
        /* eslint no-console:0 */
        console.error('hadron-spectron: App failed to quit due to error:', err);
        throw err;
      });
  }

  generateDiagnosticReport() {
    const globby = require('globby');
    const fs = require('fs');
    const rimraf = require('rimraf');
    const { chromeDriverLogPath, webdriverLogPath } = this.app.getSettings();

    var chromeDriverLogContents = '<empty file>';
    var webDriverLogContents = '<empty file>';

    const webDriverFilePath = globby.sync(
      path.join(webdriverLogPath, '*.log')
    )[0];

    var screenshotMarkup = '> App not running.';
    var electronMainLogs = '> App not running.';
    var electronRendererLogs = '> App not running.';
    var screenShotPath = path.join(this.root, `screenshot-${this.appId}.png`);

    if (fs.existsSync(chromeDriverLogPath)) {
      chromeDriverLogContents = fs.readFileSync(chromeDriverLogPath, 'utf-8');
      try {
        fs.unlinkSync(chromeDriverLogPath);
      } catch (err) {
        console.error(err);
      }
    }

    if (fs.existsSync(webDriverFilePath)) {
      try {
        webDriverLogContents = fs.readFileSync(webDriverFilePath, 'utf-8');
        fs.unlinkSync(webDriverFilePath);
        // rimraf.sync(webdriverLogPath);
      } catch (err) {
        console.error(err);
      }
    }

    const renderReport = () => {
      var report = `# Diagnostics
> AppID: ${this.appId}
> Root: ${this.root}
> AppRoot: ${this.appRoot}


## Screenshot

${screenshotMarkup}

## Electron Main Process Log

\`\`\`
${electronMainLogs}
\`\`\`

## Electron Renderer Process Log

\`\`\`
${electronRendererLogs}
\`\`\`

## Chrome Driver Log
> ${chromeDriverLogPath}

\`\`\`
${chromeDriverLogContents}
\`\`\`

## WebDriver Log
> ${webDriverFilePath}

\`\`\`
${webDriverLogContents}
\`\`\`
`;
      this.debug(report);
      fs.writeFileSync(`hadron-spectron_${this.appId}_diagnostics.md`, report);
      return report;
    };

    if (!this.app.client) {
      return Promise.resolve(renderReport());
    }
    var inspect = require('util').inspect;

    var screenshot = this.app.client.saveScreenshot(screenShotPath);

    this.app.client.getMainProcessLogs().then(logs => {
      logs.forEach(log => {
        electronMainLogs += log + '\n';
      });
    });
    this.app.client.getRenderProcessLogs().then(logs => {
      logs.forEach(log => {
        electronRendererLogs += inspect(log, true, 2, true);
      });

      try {
        screenshotMarkup = `<img src ="data:image/png;base64, ${fs.readFileSync(
          screenShotPath,
          'base64'
        )}" />`;
        fs.unlinkSync(screenShotPath);
      } catch (err) {
        console.error('Couldnt save screenshot', err);
      }

      var report = `# Diagnostics
> AppID: ${this.appId}
> Root: ${this.root}
> AppRoot: ${this.appRoot}

## Screenshot

${screenshotMarkup}

## Electron Main Process Log

\`\`\`
${electronMainLogs}
\`\`\`

## Electron Renderer Process Log

\`\`\`
${electronRendererLogs}
\`\`\`

## Chrome Driver Log
> ${chromeDriverLogPath}

\`\`\`
${chromeDriverLogContents}
\`\`\`

## WebDriver Log
> ${webDriverFilePath}

\`\`\`
${webDriverLogContents}
\`\`\`
`;
      this.debug(report);
      fs.writeFileSync(`hadron-spectron_${this.appId}_diagnostics.md`, report);
    });
    return Promise.resolve();
  }
}

module.exports = App;
module.exports.TIMEOUT = TIMEOUT;
module.exports.LONG_TIMEOUT = LONG_TIMEOUT;
