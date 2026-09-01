import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { pilotLeadController } from './pilot-lead.controller';

export const pilotLeadRoutes = Router();

// Public routes for pilot form submissions & slot availability
pilotLeadRoutes.post('/', asyncHandler(pilotLeadController.createPilotLead));
pilotLeadRoutes.get('/slot-availability', asyncHandler(pilotLeadController.getSlotAvailability));
pilotLeadRoutes.get('/settings', asyncHandler(pilotLeadController.getDemoSettings));
pilotLeadRoutes.put('/settings', asyncHandler(pilotLeadController.updateDemoSettings));

// Administrative / Protected routes
pilotLeadRoutes.get('/', asyncHandler(pilotLeadController.getAllPilotLeads));
pilotLeadRoutes.get('/:id', asyncHandler(pilotLeadController.getPilotLeadById));
pilotLeadRoutes.put('/:id', asyncHandler(pilotLeadController.updatePilotLead));
pilotLeadRoutes.delete('/:id', asyncHandler(pilotLeadController.deletePilotLead));
