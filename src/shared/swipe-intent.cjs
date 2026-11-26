/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
'use strict';
// Aster JavaScript port, 7 November2026, of the velocity-weighted success
// calculation used by Mozilla SwipeTracker::ComputeSwipeSuccess and the Zen
// consumer-threshold override. Original C++ context and pinned Zen changes:
// https://github.com/zen-browser/desktop/blob/d6d3fc65dea9025a05650dceeb06b49c9a1be3da/src/widget/SwipeTracker-cpp.patch
// https://searchfox.org/firefox-main/source/widget/SwipeTracker.cpp
// Amount and velocity are normalized page fractions and fractions/second.
function swipeSuccess({ amount, velocity, target = 1, threshold = 0.25, velocityContribution = 0.05, twitchTolerance = 0.0000001 }) {
  if (velocity * target < -twitchTolerance) return false;
  return (amount * target + velocity * target * velocityContribution) >= threshold;
}
module.exports = { swipeSuccess };
