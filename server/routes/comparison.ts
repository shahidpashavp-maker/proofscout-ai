import { Router } from 'express';
import { getStoredResearch, isValidVerificationRequest } from '../services/verification.js';
import { compareStoredResearch } from '../services/comparison.js';

const router = Router();
router.post('/compare', (request, response) => {
  if (!isValidVerificationRequest(request.body)) return response.status(400).json({ error: 'Provide a valid verification ID returned by the Fetch endpoint.' });
  const research = getStoredResearch(request.body.verificationId);
  if (!research) return response.status(404).json({ error: 'Fetched research has expired. Fetch the sources again before comparing.' });
  return response.json({ comparisons: compareStoredResearch(research.claims, research.pages) });
});

export default router;
