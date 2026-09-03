import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { pilotLeadController } from './pilot-lead.controller';
import { requireInternalAuth, requireRoles } from '../../middlewares/auth';

export const pilotLeadRoutes = Router();

/**
 * Public routes — exactly what the website's demo-booking widget needs and
 * nothing more: submit the form, see which slots are free, read the demo
 * settings that shape the widget. Everything below the guard used to be public
 * too, which meant anyone on the internet could list every demo request
 * (child's name, grade, parent's phone) and even edit them.
 */
pilotLeadRoutes.post('/', asyncHandler(pilotLeadController.createPilotLead));
pilotLeadRoutes.get('/slot-availability', asyncHandler(pilotLeadController.getSlotAvailability));
pilotLeadRoutes.get('/settings', asyncHandler(pilotLeadController.getDemoSettings));

// Administrative routes — gateway-signed identity plus a sales/ops role.
pilotLeadRoutes.use(requireInternalAuth, requireRoles(['ADMIN', 'SCHEDULER', 'ENROLLMENT_ADVISOR']));
pilotLeadRoutes.put('/settings', asyncHandler(pilotLeadController.updateDemoSettings));
pilotLeadRoutes.get('/', asyncHandler(pilotLeadController.getAllPilotLeads));
pilotLeadRoutes.get('/:id', asyncHandler(pilotLeadController.getPilotLeadById));
pilotLeadRoutes.put('/:id', asyncHandler(pilotLeadController.updatePilotLead));
pilotLeadRoutes.delete('/:id', asyncHandler(pilotLeadController.deletePilotLead));
