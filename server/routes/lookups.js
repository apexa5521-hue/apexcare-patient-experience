'use strict';

const express = require('express');
const { must } = require('../db');
const V = require('../validate');

async function activeLookups(db) {
  const [doctors, categories] = await Promise.all([
    must(db.from('doctors').select('id,name,specialty,branch').eq('active', true).order('name')),
    must(db.from('categories').select('id,name,type').eq('active', true).order('name'))
  ]);
  return {
    doctors, categories,
    branches: V.BRANCHES, specialties: V.SPECIALTIES, visitTypes: V.VISIT_TYPES, sentiments: V.SENTIMENTS,
    severities: V.SEVERITIES, statuses: V.STATUSES, planAnswers: V.PLAN_ANSWERS, notApplicable: V.NOT_APPLICABLE,
    channels: V.CHANNELS, callStatuses: V.CALL_STATUSES, callOutcomes: V.CALL_OUTCOMES
  };
}

function lookupRoutes() {
  const r = express.Router();
  r.get('/', async (req, res) => {
    res.json({ ok: true, lookups: await activeLookups(req.ctx.db), overdueDays: req.ctx.config.overdueDays });
  });
  return r;
}

module.exports = lookupRoutes;
