import { isAnsweredQuestionId } from '../logic.js';

export function createInteractionQueueState(context, { answeredCapacity = 200 } = {}) {
  const permissionQueue = [];
  const questionQueue = [];
  const answeredQuestionIds = new Set();

  function markQuestionAnswered(requestId) {
    if (!requestId) return;
    answeredQuestionIds.add(requestId);
    while (answeredQuestionIds.size > answeredCapacity) {
      answeredQuestionIds.delete(answeredQuestionIds.values().next().value);
    }
  }

  function isQuestionAnswered(requestId) {
    return isAnsweredQuestionId(requestId, answeredQuestionIds);
  }

  const state = {
    permissionQueue,
    questionQueue,
    answeredQuestionIds,
    markQuestionAnswered,
    isQuestionAnswered,
  };
  context.state.interactions = state;
  return state;
}
