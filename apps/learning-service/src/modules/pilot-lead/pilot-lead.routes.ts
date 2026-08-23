import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { pilotLeadController } from './pilot-lead.controller';

export const pilotLeadRoutes = Router();

// Public route for pilot form submissions
pilotLeadRoutes.post('/', asyncHandler(pilotLeadController.createPilotLead));

// Administrative / Protected routes
pilotLeadRoutes.get('/', asyncHandler(pilotLeadController.getAllPilotLeads));
pilotLeadRoutes.get('/:id', asyncHandler(pilotLeadController.getPilotLeadById));
pilotLeadRoutes.put('/:id', asyncHandler(pilotLeadController.updatePilotLead));
pilotLeadRoutes.delete('/:id', asyncHandler(pilotLeadController.deletePilotLead));
