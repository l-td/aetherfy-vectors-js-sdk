/* global require, module */
// FIXTURE: runs the fixture's files in path order, so a-crashes-on-load runs
// before b-mocks-a-request every time instead of in whatever order Jest's
// default sequencer (duration, file size, previous failures) picks.
const Sequencer = require('@jest/test-sequencer').default;

module.exports = class PathOrder extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
};
