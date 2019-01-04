/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Checks that links, buttons, etc. are sufficiently large and don't overlap.
 */
const Audit = require('../audit');
const ViewportAudit = require('../viewport');
const {
  getRectOverlapArea,
  getRectAtCenter,
  allRectsContainedWithinEachOther,
  getLargestRect,
} = require('../../lib/rect-helpers');
const {getTappableRectsFromClientRects} = require('../../lib/tappable-rects');

const FINGER_SIZE_PX = 48;
// Ratio of the finger area tapping on an unintended element
// to the finger area tapping on the intended element
const MAX_ACCEPTABLE_OVERLAP_SCORE_RATIO = 0.25;


/**
 * @param {LH.Artifacts.Rect} cr
 */
function clientRectMeetsMinimumSize(cr) {
  return cr.width >= FINGER_SIZE_PX && cr.height >= FINGER_SIZE_PX;
}

/**
 * A target is "too small" if none of it's clientRects are at least the size of a finger.
 * @param {LH.Artifacts.TapTarget} target
 */
function targetIsTooSmall(target) {
  for (const cr of target.clientRects) {
    if (clientRectMeetsMinimumSize(cr)) {
      return false;
    }
  }
  return true;
}

/**
 *
 * @param {LH.Artifacts.TapTarget[]} targets
 */
function getTooSmallTargets(targets) {
  return targets.filter(targetIsTooSmall);
}

/**
 *
 * @param {LH.Artifacts.TapTarget[]} tooSmallTargets
 * @param {LH.Artifacts.TapTarget[]} allTargets
 */
function getAllFailures(tooSmallTargets, allTargets) {
  /** @type {LH.Audit.TapTargetOverlapDetail[]} */
  let failures = [];

  tooSmallTargets.forEach(target => {
    const overlappingTargets = getAllFailuresForTarget(
      target,
      allTargets
    );

    if (overlappingTargets.length > 0) {
      failures = failures.concat(overlappingTargets);
    }
  });

  return failures;
}

/**
 *
 * @param {LH.Artifacts.TapTarget} tapTarget
 * @param {LH.Artifacts.TapTarget[]} allTapTargets
 */
function getAllFailuresForTarget(tapTarget, allTapTargets) {
  /** @type LH.Audit.TapTargetOverlapDetail[] */
  const failures = [];

  for (const maybeOverlappingTarget of allTapTargets) {
    if (maybeOverlappingTarget === tapTarget) {
      // checking the same target with itself, skip
      continue;
    }

    const failure = getFailureForTargetPair(tapTarget, maybeOverlappingTarget);
    if (failure) {
      failures.push(failure);
    }
  }

  return failures;
}

/**
 * @param {LH.Artifacts.TapTarget} tapTarget
 * @param {LH.Artifacts.TapTarget} maybeOverlappingTarget
 * @returns {LH.Audit.TapTargetOverlapDetail | null}
 */
function getFailureForTargetPair(tapTarget, maybeOverlappingTarget) {
  // convert client rects to unique tappable areas from a user's perspective
  const tappableRects = getTappableRectsFromClientRects(tapTarget.clientRects);
  const isHttpOrHttpsLink = /https?:\/\//.test(tapTarget.href);
  if (isHttpOrHttpsLink && tapTarget.href === maybeOverlappingTarget.href) {
    // no overlap because same target action
    return null;
  }

  if (allRectsContainedWithinEachOther(tappableRects, maybeOverlappingTarget.clientRects)) {
    // If one tap target is fully contained within the other that's
    // probably intentional (e.g. an item with a delete button inside)
    return null;
  }

  /** @type LH.Audit.TapTargetOverlapDetail | null */
  let greatestFailure = null;
  for (const targetCR of tappableRects) {
    for (const maybeOverlappingCR of maybeOverlappingTarget.clientRects) {
      const failure = getFailureForClientRectPair(targetCR, maybeOverlappingCR);
      if (failure) {
        // only update our state if this was the biggest failure we've seen for this pair
        if (!greatestFailure ||
          failure.overlapScoreRatio > greatestFailure.overlapScoreRatio) {
          greatestFailure = {
            ...failure,
            tapTarget,
            overlappingTarget: maybeOverlappingTarget,
          };
        }
      }
    }
  }
  return greatestFailure;
}

/**
 * @param {LH.Artifacts.Rect} targetCR
 * @param {LH.Artifacts.Rect} maybeOverlappingCR
 * @returns {LH.Audit.ClientRectOverlapDetail | null}
 */
function getFailureForClientRectPair(targetCR, maybeOverlappingCR) {
  const fingerRect = getRectAtCenter(targetCR, FINGER_SIZE_PX);
  // Score indicates how much of the finger area overlaps each target when the user
  // taps on the center of targetCR
  const tapTargetScore = getRectOverlapArea(fingerRect, targetCR);
  const maybeOverlappingScore = getRectOverlapArea(fingerRect, maybeOverlappingCR);

  const overlapScoreRatio = maybeOverlappingScore / tapTargetScore;
  if (overlapScoreRatio < MAX_ACCEPTABLE_OVERLAP_SCORE_RATIO) {
    // low score means it's clear that the user tried to tap on the targetCR,
    // rather than the other tap target client rect
    return null;
  }

  return {
    overlapScoreRatio,
    tapTargetScore,
    overlappingTargetScore: maybeOverlappingScore,
  };
}

/**
 * Only report one failure if two targets overlap each other
 * @param {LH.Audit.TapTargetOverlapDetail[]} overlapFailures
 * @returns {LH.Audit.TapTargetOverlapDetail[]}
 */
function mergeSymmetricFailures(overlapFailures) {
  /** @type LH.Audit.TapTargetOverlapDetail[] */
  const failuresAfterMerging = [];
  overlapFailures.forEach((failure, overlapFailureIndex) => {
    const symmetricFailure = overlapFailures.find(f =>
      f.tapTarget === failure.overlappingTarget &&
      f.overlappingTarget === failure.tapTarget
    );

    if (!symmetricFailure) {
      failuresAfterMerging.push(failure);
      return;
    }

    const {overlapScoreRatio: failureOSR} = failure;
    const {overlapScoreRatio: symmetricOSR} = symmetricFailure;
    if (failureOSR > symmetricOSR || (
      // If same score for failure and symmetric failure, pick the first one in the list
      failureOSR === symmetricOSR &&
      overlapFailureIndex < overlapFailures.indexOf(symmetricFailure)
    )) {
      failuresAfterMerging.push(failure);
    } else {
      // The symmetric failure will be pushed later
    }
  });

  return failuresAfterMerging;
}

/**
 * @param {LH.Audit.TapTargetOverlapDetail[]} overlapFailures
 */
function getTableItems(overlapFailures) {
  const tableItems = overlapFailures.map(
    ({
      tapTarget,
      overlappingTarget,
      tapTargetScore,
      overlappingTargetScore,
      overlapScoreRatio,
    }) => {
      const largestCR = getLargestRect(tapTarget.clientRects);
      const width = Math.floor(largestCR.width);
      const height = Math.floor(largestCR.height);
      const size = width + 'x' + height;
      return {
        tapTarget: targetToTableNode(tapTarget),
        overlappingTarget: targetToTableNode(overlappingTarget),
        size,
        width,
        height,
        tapTargetScore,
        overlappingTargetScore,
        overlapScoreRatio,
      };
    });

  tableItems.sort((a, b) => {
    return b.overlapScoreRatio - a.overlapScoreRatio;
  });

  return tableItems;
}

/**
 * @param {LH.Artifacts.TapTarget} target
 * @returns {LH.Audit.DetailsRendererNodeDetailsJSON}
 */
function targetToTableNode(target) {
  return {
    type: 'node',
    snippet: target.snippet,
    path: target.path,
    selector: target.selector,
  };
}

class TapTargets extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'tap-targets',
      title: 'Tap targets are sized appropriately',
      failureTitle: 'Tap targets are not sized appropriately',
      description:
        'Interactive elements like buttons and links should be large enough (48x48px), and have enough space around them, to be easy enough to tap without overlapping onto other elements. [Learn more](https://developers.google.com/web/fundamentals/accessibility/accessible-styles#multi-device_responsive_design).',
      requiredArtifacts: ['Viewport', 'TapTargets'],
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @return {LH.Audit.Product}
   */
  static audit(artifacts) {
    const hasViewportSet = ViewportAudit.audit(artifacts).rawValue;
    if (!hasViewportSet) {
      return {
        rawValue: false,
        explanation:
          'Tap targets are too small because of a missing viewport config',
      };
    }

    const tooSmallTargets = getTooSmallTargets(artifacts.TapTargets);
    const overlapFailures = getAllFailures(tooSmallTargets, artifacts.TapTargets);
    const uniqueOverlapFailures = mergeSymmetricFailures(overlapFailures);
    const tableItems = getTableItems(uniqueOverlapFailures);

    const headings = [
      {key: 'tapTarget', itemType: 'node', text: 'Tap Target'},
      {key: 'size', itemType: 'text', text: 'Size'},
      {key: 'overlappingTarget', itemType: 'node', text: 'Overlapping Target'},
    ];

    const details = Audit.makeTableDetails(headings, tableItems);

    const tapTargetCount = artifacts.TapTargets.length;
    const failingTapTargetCount = new Set(overlapFailures.map(f => f.tapTarget)).size;
    const passingTapTargetCount = tapTargetCount - failingTapTargetCount;

    const score = tapTargetCount > 0 ? passingTapTargetCount / tapTargetCount : 1;
    const displayValue = Math.round(score * 100) + '% appropriately sized tap targets';

    return {
      rawValue: tableItems.length === 0,
      score,
      details,
      displayValue,
    };
  }
}

TapTargets.FINGER_SIZE_PX = FINGER_SIZE_PX;

module.exports = TapTargets;
