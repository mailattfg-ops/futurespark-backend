import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { leadService } from './lead.service';
import { validateCreateLead, validateUpdateLead } from './lead.schema';

export const leadController = {
  async list(req: Request, res: Response) {
    const leads = await leadService.getAllLeads();
    return res.status(HTTP_STATUS.OK).json(successResponse(leads, 'Leads fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    const lead = await leadService.getLeadById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Lead fetched successfully'));
  },

  async create(req: Request, res: Response) {
    const input = validateCreateLead(req.body);
    const lead = await leadService.createLead(input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(lead, 'Lead created successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateLead(req.body);
    const lead = await leadService.updateLead(req.params.id, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Lead updated successfully'));
  },

  async delete(req: Request, res: Response) {
    await leadService.deleteLead(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Lead deleted successfully'));
  },
};
