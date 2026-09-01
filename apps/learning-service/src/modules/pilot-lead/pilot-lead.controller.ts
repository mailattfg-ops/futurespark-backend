import { Request, Response } from 'express';
import { pilotLeadService } from './pilot-lead.service';
import { validateCreatePilotLead, validateUpdatePilotLead } from './pilot-lead.schema';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';

export const pilotLeadController = {
  async getDemoSettings(_req: Request, res: Response) {
    const settings = await pilotLeadService.getDemoSettings();
    return res.status(HTTP_STATUS.OK).json(successResponse(settings, 'Demo settings fetched successfully'));
  },

  async updateDemoSettings(req: Request, res: Response) {
    const { demoTeachersCount } = req.body;
    const settings = await pilotLeadService.updateDemoSettings(demoTeachersCount);
    return res.status(HTTP_STATUS.OK).json(successResponse(settings, 'Demo settings updated successfully'));
  },

  async getSlotAvailability(req: Request, res: Response) {
    const dateQuery = req.query.date as string | undefined;
    const availability = await pilotLeadService.getSlotAvailability(dateQuery);
    return res.status(HTTP_STATUS.OK).json(successResponse(availability, 'Slot availability fetched successfully'));
  },

  async getAllPilotLeads(_req: Request, res: Response) {
    const leads = await pilotLeadService.getAllPilotLeads();
    return res.status(HTTP_STATUS.OK).json(successResponse(leads, 'Pilot Leads fetched successfully'));
  },

  async getPilotLeadById(req: Request, res: Response) {
    const { id } = req.params;
    const lead = await pilotLeadService.getPilotLeadById(id);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Pilot Lead details fetched successfully'));
  },

  async createPilotLead(req: Request, res: Response) {
    const validatedInput = validateCreatePilotLead(req.body);
    // Manual entries from the Pilot Leads page are not ad conversions.
    const newLead = await pilotLeadService.createPilotLead({
      ...validatedInput,
      staffEntry: !!req.headers.authorization,
    });
    return res.status(HTTP_STATUS.CREATED).json(successResponse(newLead, 'Pilot lead application submitted successfully'));
  },

  async updatePilotLead(req: Request, res: Response) {
    const { id } = req.params;
    const validatedInput = validateUpdatePilotLead(req.body);
    const updatedLead = await pilotLeadService.updatePilotLead(id, validatedInput);
    return res.status(HTTP_STATUS.OK).json(successResponse(updatedLead, 'Pilot lead updated successfully'));
  },

  async deletePilotLead(req: Request, res: Response) {
    const { id } = req.params;
    const result = await pilotLeadService.deletePilotLead(id);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Pilot lead deleted successfully'));
  },
};
