import { Router } from 'express';
import { isValidVerificationRequest, verifyStoredClaims } from '../services/verification.js';

const router = Router();
router.post('/verify', (request, response) => {
  if (!isValidVerificationRequest(request.body)) return response.status(400).json({ error: 'Provide a valid verification ID returned by the Fetch endpoint.' });
  const results = verifyStoredClaims(request.body.verificationId);
  if (!results) return response.status(404).json({ error: 'Fetched research has expired. Fetch the sources again before verifying.' });
  return response.json({ results });
});

export default router;
